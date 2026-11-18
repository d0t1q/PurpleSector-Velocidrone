// Minimal stand-in for Velocidrone's race websocket (ws://host:60003/velocidrone), for testing.
// Speaks just enough RFC 6455: unmasked text frames out, masked frames in.
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeVelocidrone(port) {
  const server = http.createServer((req, res) => res.writeHead(426).end());
  let sock = null;
  let waiters = [];
  const received = [];

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/velocidrone') return socket.destroy();
    // Like the real game's server: header names are matched case-sensitively.
    const names = req.rawHeaders.filter((_, i) => i % 2 === 0);
    if (!['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version'].every((h) => names.includes(h))) {
      socket.end('HTTP/1.1 400 Bad Request\r\nServer: [eToile] SocketsUnderControl.WSServer\r\nSec-WebSocket-Version: 13\r\n\r\n');
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (sock) sock.destroy(); // game allows a single client
    sock = socket;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) break;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 0x80;
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) break;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(need);
        if (op === 1) received.push(payload.toString('utf8'));
        if (op === 8) socket.end();
      }
    });
    socket.on('close', () => { if (sock === socket) sock = null; });
    socket.on('error', () => {});
    waiters.forEach((w) => w());
    waiters = [];
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        received,
        get connected() { return !!sock; },
        waitConnected() { return sock ? Promise.resolve() : new Promise((r) => waiters.push(r)); },
        waitNextConnection() { return new Promise((r) => waiters.push(r)); },
        send(obj) {
          if (!sock) return false;
          const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
          // The real game sends JSON in binary frames (opcode 2).
          let head;
          if (data.length < 126) head = Buffer.from([0x82, data.length]);
          else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x82; head[1] = 126; head.writeUInt16BE(data.length, 2); }
          else { head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
          sock.write(Buffer.concat([head, data]));
          return true;
        },
        close() { if (sock) sock.destroy(); server.close(); },
      }),
    ),
  );
}
