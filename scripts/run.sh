#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x .venv/bin/python || ! -f frontend/dist/index.html ]]; then
  echo '请先运行 bash scripts/setup.sh' >&2
  exit 1
fi
export CUDA_VISIBLE_DEVICES=-1
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-$PWD/data/numba-cache}"
exec .venv/bin/uvicorn backend.app:app --host "${MELODY_HOST:-0.0.0.0}" --port "${MELODY_PORT:-7865}" --workers 1
