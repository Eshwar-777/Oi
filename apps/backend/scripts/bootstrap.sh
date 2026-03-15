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
GOOGLE_CLOUD_PROJECT=my-oi-488718
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
GEMINI_LIVE_MODEL_FALLBACKS=gemini-live-2.5-flash-native-audio,gemini-live-2.5-flash-preview-native-audio-09-2025,gemini-2.0-flash-live-001
GEMINI_COMPUTER_USE_MODEL=gemini-2.5-pro
GEMINI_COMPUTER_USE_MODEL_FALLBACKS=gemini-2.5-pro,gemini-2.5-flash
ADK_APP_NAME=oi-adk-chatbot
ADK_SESSION_BACKEND=memory

# ---- Feature flags ----
ENABLE_LIVE_STREAMING=true
ENABLE_COMPUTER_USE=true
ENABLE_VISION_TOOLS=true
COMPUTER_USE_MAX_STEPS=18
COMPUTER_USE_ACTION_DELAY_MS=900

# ---- Security ----
ALLOWED_ORIGINS=http://localhost:3000
REQUEST_TIMEOUT_SECONDS=30
MAX_TOOL_CALLS_PER_REQUEST=10
AUTOMATION_RUNTIME_ENABLED=true
AUTOMATION_RUNTIME_BASE_URL=http://127.0.0.1:8787
AUTOMATION_RUNTIME_SHARED_SECRET=local-dev-runtime-secret
RUNNER_SHARED_SECRET=local-dev-runner-secret
EOF
fi

echo "Bootstrap complete. Update .env before running."
