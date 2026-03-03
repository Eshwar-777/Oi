#!/usr/bin/env bash
set -euo pipefail

python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt

if [ ! -f .env ]; then
  cat > .env << 'EOF'
# ---- App ----
ENV=dev
APP_NAME=oi-agent
APP_HOST=0.0.0.0
APP_PORT=8080
LOG_LEVEL=INFO

# ---- Auth / Gemini / ADK ----
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001
ADK_APP_NAME=oi-adk-chatbot
ADK_SESSION_BACKEND=memory

# ---- Feature flags ----
ENABLE_LIVE_STREAMING=true
ENABLE_COMPUTER_USE=false
ENABLE_VISION_TOOLS=true

# ---- Security ----
ALLOWED_ORIGINS=http://localhost:3000
REQUEST_TIMEOUT_SECONDS=30
MAX_TOOL_CALLS_PER_REQUEST=10
EOF
fi

echo "Bootstrap complete. Update .env before running."
