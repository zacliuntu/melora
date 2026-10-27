#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
.venv/bin/python -m pytest tests -q
.venv/bin/python tests/make_fixture.py /tmp/melody-test-phrase.wav
npm --prefix frontend run build
TEST_DATA="$(mktemp -d /tmp/melody-e2e.XXXXXX)"
MELODY_DATA_DIR="$TEST_DATA" MELODY_PORT=17865 MELODY_HOST=127.0.0.1 bash scripts/run.sh > "$TEST_DATA/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; echo "测试数据与服务日志: $TEST_DATA"' EXIT
for i in {1..60}; do
  if curl -fsS http://127.0.0.1:17865/api/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then cat "$TEST_DATA/server.log"; exit 1; fi
  sleep 1
done
npm --prefix frontend run test:e2e
