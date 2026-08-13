#!/usr/bin/env bash
# Starts the reporting server and opens it in your browser. Ctrl-C stops it.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get it from https://nodejs.org (version 18 or newer),"
  echo "  then run this again."
  echo
  exit 1
fi

# First run: create server/.env with a freshly generated signing secret.
if [ ! -f server/.env ]; then
  echo "  First run - creating server/.env"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" server/.env.example > server/.env
  echo "  A signing secret was generated. Add MONGODB_URI to server/.env to keep data."
fi

PORT=$(grep -E '^PORT=' server/.env | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-4000}
URL="http://localhost:$PORT/"

( sleep 1.5
  if   command -v open     >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec node server/src/server.js
