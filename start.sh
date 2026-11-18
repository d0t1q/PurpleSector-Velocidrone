#!/bin/sh
# PurpleSector - live timing for Velocidrone. Run ./start.sh; the page opens in your browser (http://127.0.0.1:8090).
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/sector-timer.mjs" --open "$@"
