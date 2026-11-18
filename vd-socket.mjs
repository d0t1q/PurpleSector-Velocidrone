// Minimal WebSocket client for Velocidrone's race feed.
//
// Why not Node's built-in WebSocket: the game's server (eToile SocketsUnderControl.WSServer) matches
// handshake header names case-sensitively ("Sec-WebSocket-Key:") and answers 400 Bad Request to the
// lowercase headers Node's client sends. node:http keeps header case as given, so we do the handshake
// with it and handle RFC 6455 framing ourselves. The game sends JSON in binary frames.
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

/**
 * Connect to ws://host:port/path. Returns an EventEmitter:
 *   'open'                   handshake done
 *   'message' (text)         a complete text or binary message, decoded as UTF-8
 *   'close'   (reason)       always emitted exactly once (also after failed connects)
 * plus send(text) and close().
 */
export function connectWs(url, { timeoutMs = 3000 } = {}) {
  const u = new URL(url);
  const ee = new EventEmitter();
  const key = crypto.randomBytes(16).toString('base64');
  let socket = null;
  let closed = false;

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (socket) socket.destroy();
    else req.destroy();
    ee.emit('close', reason);
  };

  const req = http.request({
    host: u.hostname,
    port: Number(u.port) || 80,
    path: (u.pathname || '/') + u.search,
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });
  const timer = setTimeout(() => finish('timeout'), timeoutMs);

  req.on('error', (e) => finish(e.code || e.message));
  req.on('response', (res) => {
    res.resume();
    finish(`HTTP ${res.statusCode} (no websocket upgrade)`);
  });
  req.on('upgrade', (res, sock, head) => {
    clearTimeout(timer);
    socket = sock;
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    if (res.headers['sec-websocket-accept'] !== expect) return finish('bad Sec-WebSocket-Accept');
    sock.setNoDelay(true);
    sock.on('error', (e) => finish(e.code || e.message));
    sock.on('close', () => finish('socket closed'));
    sock.on('end', () => finish('socket ended'));

    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragments = [];
    let fragLen = 0;
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (len > MAX_MESSAGE) return finish('frame too large');
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        let payload = buf.subarray(off + (masked ? 4 : 0), total);
        if (masked) {
          const m = buf.subarray(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
        }
        buf = buf.subarray(total);

        if (op === 0x8) {
          sendFrame(0x8, Buffer.alloc(0));
          return finish('closed by game');
        } else if (op === 0x9) {
          sendFrame(0xa, payload); // ping -> pong
        } else if (op === 0x0 || op === 0x1 || op === 0x2) {
          fragments.push(Buffer.from(payload));
          fragLen += payload.length;
          if (fragLen > MAX_MESSAGE) return finish('message too large');
          if (fin) {
            const text = Buffer.concat(fragments, fragLen).toString('utf8');
            fragments = [];
            fragLen = 0;
            ee.emit('message', text);
          }
        }
      }
    };
    ee.emit('open');
    if (buf.length) {
      const first = buf;
      buf = Buffer.alloc(0);
      onData(first);
    }
    sock.on('data', onData);
  });
  req.end();

  function sendFrame(op, payload) {
    if (!socket || closed) return false;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    socket.write(Buffer.concat([head, mask, body]));
    return true;
  }

  ee.send = (text) => sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  ee.close = () => {
    sendFrame(0x8, Buffer.alloc(0));
    finish('closed');
  };
  return ee;
}
