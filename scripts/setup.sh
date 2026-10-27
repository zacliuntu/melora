#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v ffmpeg >/dev/null || { echo '需要先安装 FFmpeg。' >&2; exit 1; }
command -v npm >/dev/null || { echo '需要先安装 Node.js 20+ / npm。' >&2; exit 1; }
if command -v uv >/dev/null; then
  UV_BIN="$(command -v uv)"
elif [[ -x ../.venv/bin/uv ]]; then
  UV_BIN="$PWD/../.venv/bin/uv"
else
  python3 -m venv .bootstrap
  .bootstrap/bin/pip install uv
  UV_BIN="$PWD/.bootstrap/bin/uv"
fi
if [[ ! -x .venv/bin/python ]]; then
  "$UV_BIN" venv --python 3.10 .venv
fi
"$UV_BIN" pip install --python .venv/bin/python -r requirements.lock.txt
npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build
echo '准备完成。启动：bash scripts/run.sh；浏览器访问服务器的 7865 端口。'
