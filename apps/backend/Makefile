VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
UVICORN := $(VENV)/bin/uvicorn
GUNICORN := $(VENV)/bin/gunicorn
PYTEST := $(VENV)/bin/pytest
RUFF := $(VENV)/bin/ruff
MYPY := $(VENV)/bin/mypy

HOST ?= 0.0.0.0
PORT ?= 8080
WORKERS ?= 2
TIMEOUT ?= 120

.PHONY: bootstrap install dev run prod scheduler adc-login test lint format typecheck check

$(VENV)/bin/activate:
	python3 -m venv $(VENV)

bootstrap: $(VENV)/bin/activate
	$(PIP) install -U pip
	$(PIP) install -r requirements.txt
	@if [ ! -f .env ]; then \
		echo "Creating .env for dev mode..."; \
		printf "%s\n" \
		"ENV=dev" \
		"APP_NAME=oi-agent" \
		"APP_HOST=0.0.0.0" \
		"APP_PORT=8080" \
		"LOG_LEVEL=INFO" \
		"" \
		"GOOGLE_GENAI_USE_VERTEXAI=true" \
		"GOOGLE_CLOUD_PROJECT=my-oi-488718" \
		"GOOGLE_CLOUD_LOCATION=us-central1" \
		"GOOGLE_APPLICATION_CREDENTIALS=" \
		"GEMINI_MODEL=gemini-2.5-flash" \
		"GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio" \
		"GEMINI_LIVE_MODEL_FALLBACKS=gemini-live-2.5-flash-native-audio,gemini-live-2.5-flash-preview-native-audio-09-2025,gemini-2.0-flash-live-001" \
		"GEMINI_COMPUTER_USE_MODEL=gemini-2.5-pro" \
		"GEMINI_COMPUTER_USE_MODEL_FALLBACKS=gemini-2.5-pro,gemini-2.5-flash" \
		"ADK_APP_NAME=oi-adk-chatbot" \
		"" \
		"ENABLE_LIVE_STREAMING=true" \
		"ENABLE_COMPUTER_USE=true" \
		"ENABLE_VISION_TOOLS=true" \
		"COMPUTER_USE_MAX_STEPS=18" \
		"COMPUTER_USE_ACTION_DELAY_MS=900" \
		"" \
		"REQUEST_TIMEOUT_SECONDS=30" \
		"MAX_TOOL_CALLS_PER_REQUEST=10" \
		"" \
		"AUTOMATION_RUNTIME_ENABLED=true" \
		"AUTOMATION_RUNTIME_BASE_URL=http://127.0.0.1:8787" \
		"AUTOMATION_RUNTIME_SHARED_SECRET=local-dev-runtime-secret" \
		"RUNNER_SHARED_SECRET=local-dev-runner-secret" > .env; \
		echo "Created .env"; \
	fi

install: bootstrap

dev: bootstrap
	PYTHONPATH=src $(UVICORN) oi_agent.main:app --reload --host $(HOST) --port $(PORT)

run: dev

prod: bootstrap
	PYTHONPATH=src $(GUNICORN) oi_agent.main:app -k uvicorn.workers.UvicornWorker -w $(WORKERS) -b $(HOST):$(PORT) --timeout $(TIMEOUT)

scheduler: bootstrap
	AUTOMATION_SCHEDULER_MODE=worker PYTHONPATH=src $(PYTHON) -m oi_agent.automation.scheduler_worker

adc-login:
	bash ./scripts/setup_adc.sh

test: bootstrap
	PYTHONPATH=src $(PYTEST) -q

lint: bootstrap
	$(RUFF) check src tests

format: bootstrap
	$(RUFF) check src tests --fix

typecheck: bootstrap
	PYTHONPATH=src $(MYPY) src

check: lint typecheck test
