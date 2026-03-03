# OI

An interactive AI agent that automates tasks through natural conversation.

OI has two systems:
- **Converse** -- Multimodal chatbot (text, voice, images, camera, documents)
- **Task Lifecycle** -- Curate (plan), Companion (execute), Consult (human-in-the-loop) working as a single state machine

## Repository Structure

```
apps/
  backend/    Python FastAPI + Google ADK + LangGraph
  web/        Next.js landing page + dashboard
  mobile/     React Native Expo app
  desktop/    Electron shell (wraps web frontend)
  extension/  Chrome browser extension (MV3)

packages/
  shared-types/  @oi/shared-types -- API and domain types
  api-client/    @oi/api-client -- REST + Firestore + WebSocket clients
  theme/         @oi/theme -- Design tokens (maroon palette)
```

## Quick Start

```bash
# Install all TypeScript dependencies
pnpm install

# Bootstrap the Python backend
cd apps/backend && make bootstrap && cd ../..

# Configure GCP
gcloud auth application-default login

# Copy env files
cp apps/backend/.env.example apps/backend/.env
# Edit .env with your GCP project ID

# Run services
pnpm dev:backend    # FastAPI on :8080
pnpm dev:web        # Next.js on :3000
pnpm dev:mobile     # Expo on :8081
```

## Prerequisites

- Python 3.11+
- Node.js 20+ and pnpm 9+
- Google Cloud SDK (`gcloud`)

## Pre-commit Secret Scan

This repo includes a pre-commit hook that scans staged files for common key/token patterns.

```bash
git config core.hooksPath .githooks
```

To run the scanner manually:

```bash
./scripts/scan-staged-secrets.sh
```

## Color Palette

- Primary: `#751636` (maroon)
- Deep: `#33101c` (dark maroon)
- Neutral: whites and blacks
