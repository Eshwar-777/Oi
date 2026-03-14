# Release Runbook

## Scope

Primary release surfaces:

- Backend
- Web
- Mobile

Secondary surfaces:

- Desktop
- Extension

## Required GitHub environment

- `production`

Use one environment for this production setup.

## Backend release checklist

- Preflight passes: `node scripts/release-preflight.mjs backend`
- `Backend CI/CD` passes.
- `ARTIFACT_REGISTRY`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, and `GCP_PROJECT_ID` are configured.
- Production deploy is triggered manually with approval.
- Smoke check succeeds after deploy.
- Rollback target image tag is recorded before production deploy.

## Web release checklist

- Preflight passes: `node scripts/release-preflight.mjs web`
- `Web CI/CD` passes with `--frozen-lockfile`.
- Required `VITE_*` environment variables are present in the `production` environment.
- Backend base URL and auth callback URLs are verified against production.
- Built artifact is archived before promotion.

## Mobile release checklist

- Preflight passes: `node scripts/release-preflight.mjs mobile`
- `Mobile CI/CD` passes with `--frozen-lockfile`.
- `expo-doctor` passes.
- `apps/frontend/mobile/eas.json` profiles match the intended release channel.
- `EXPO_TOKEN` is configured.
- `EXPO_PUBLIC_API_URL` is configured in `production`.
- Firebase, API base URL, push notification, deep link, and bundle/package identifiers are verified for production.
- Production uses the `production` EAS profile and requires manual approval.
- Production submission is triggered separately after a successful production build.

## First deployment rehearsal

Run this sequence before telling people the project is live:

1. Trigger backend production deploy.
2. Trigger web production deploy.
3. Trigger mobile production build.
4. Verify login, API traffic, automation session updates, and notifications.
5. Trigger mobile production submit after the build is confirmed good.
6. Record the backend image tag, web revision, and EAS build IDs.
