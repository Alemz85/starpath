#!/usr/bin/env bash
# One-time bootstrap for the JobSpy scraper.
# Creates a project-local Python venv at scripts/jobspy/.venv and installs deps.
# Idempotent — safe to re-run after pulling new requirements.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQ_FILE="$SCRIPT_DIR/requirements.txt"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[setup] error: python3 not found in PATH" >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "[setup] creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
. "$VENV_DIR/bin/activate"

echo "[setup] upgrading pip"
python -m pip install --upgrade pip >/dev/null

echo "[setup] installing requirements"
pip install -r "$REQ_FILE"

echo "[setup] done. Smoke test:"
python -c "import jobspy, yaml; print('jobspy', jobspy.__version__ if hasattr(jobspy, '__version__') else 'ok'); print('yaml', yaml.__version__)"
