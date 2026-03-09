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
		"GOOGLE_CLOUD_PROJECT=your-gcp-project-id" \
		"GOOGLE_CLOUD_LOCATION=us-central1" \
		"GOOGLE_APPLICATION_CREDENTIALS=" \
		"GEMINI_MODEL=gemini-2.5-flash" \
		"GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001" \
		"ADK_APP_NAME=oi-adk-chatbot" \
		"" \
		"ENABLE_LIVE_STREAMING=true" \
		"ENABLE_COMPUTER_USE=false" \
		"ENABLE_VISION_TOOLS=true" \
		"" \
		"REQUEST_TIMEOUT_SECONDS=30" \
		"MAX_TOOL_CALLS_PER_REQUEST=10" > .env; \
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
