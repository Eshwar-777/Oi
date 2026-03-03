#!/usr/bin/env bash
set -euo pipefail

source .venv/bin/activate
PYTHONPATH=src uvicorn oi_agent.main:app --reload --host 0.0.0.0 --port 8080
