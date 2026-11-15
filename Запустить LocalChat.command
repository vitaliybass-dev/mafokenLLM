#!/bin/zsh
set -eu
cd -- "${0:A:h}"
url=http://127.0.0.1:8769
/usr/bin/python3 server.py &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  kill -0 "$pid" 2>/dev/null || { wait "$pid"; exit; }
  if /usr/bin/curl -fsS --max-time 1 "$url/" > /dev/null; then
    /usr/bin/open "$url"
    wait "$pid"
    exit
  fi
  sleep 0.1
done
echo "Не удалось открыть LocalChat."
exit 1
