# SilverVisit Backend

Node.js + TypeScript backend for:
- screenshot-grounded planner turns on Vertex Gemini
- Gemini Live WebSocket proxy for text/image/audio
- Firestore-backed fixture/session/event persistence

## Routes
- `GET /health`
  - returns: `useVertexAI`, `vertexConfigured`, `liveEnabled`, `liveApiConfigured`, `plannerModel`, `liveModel`, `googleCloudProjectConfigured`, `googleCloudLocation`, `firestoreConfigured`, `firestoreMode`
- `POST /api/session/start`
- `GET /api/session/:id`
- `POST /api/plan-action`
- `GET /api/sandbox/fixture?seed=<n>`
- `POST /api/sandbox/run/start`
- `POST /api/sandbox/run/event`
- `WS /api/live`

## Firestore Collections
- `sandboxFixtures`
- `sandboxRuns`
- `navigatorSessions`
- `liveEvents`
- `actionLogs`

## Firestore Seed Bootstrap
```bash
cd backend
npm run seed:firestore
```

## Env Vars
Template: [backend/.env.example](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/.env.example)

Core:
- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION`
- `GEMINI_ACTION_MODEL`
- `GEMINI_LIVE_MODEL`
- `ENABLE_LIVE_API=true`
- `ENABLE_FIRESTORE=true`
- `FIRESTORE_COLLECTION_PREFIX=silvervisit`
- `FIRESTORE_EMULATOR_HOST` (optional emulator mode)

## Build / Smoke
```bash
cd backend
npm run build
npm run smoke
```

## Cloud Run Deployment (Copy/Paste)
Locked profile:
- service: `silvervisit-backend`
- region: `us-central1`
- auth: `allow-unauthenticated`
- timeout: `900s`
- runtime port: `8080`

Runtime contract source:
- [backend/deploy/cloud-run.contract.json](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/deploy/cloud-run.contract.json)

Deploy + post-deploy verification:
```bash
cd backend
bash scripts/deploy-cloud-run.sh \
  --service silvervisit-backend \
  --project YOUR_GCP_PROJECT \
  --region us-central1 \
  --location us-central1 \
  --timeout-seconds 900
```

PowerShell equivalent:
```powershell
cd backend
.\scripts\deploy-cloud-run.ps1 `
  -Service silvervisit-backend `
  -Project YOUR_GCP_PROJECT `
  -Region us-central1 `
  -Location us-central1 `
  -TimeoutSeconds 900
```

Run deployed verification manually:
```bash
cd backend
npm run verify:cloud-run -- \
  --base-url https://YOUR_SERVICE_URL.run.app \
  --service silvervisit-backend \
  --region us-central1 \
  --project YOUR_GCP_PROJECT
```

Expected verifier proof output:
- anonymous `GET /health` reachability
- `/health` Google truth fields (Vertex/Live/model names/firestore/runtime)
- `POST /api/session/start` success
- `POST /api/plan-action` grounded response shape
- `WS /api/live` contract evidence
- deployed Cloud Run timeout = `900`
- Node timeout diagnostics from `/health`
- explicit manual browser-only live proof step when required

## Secret Hygiene
```bash
cd backend
npm run secret:hygiene
```
Expected output:
- `[hygiene] no secrets detected in tracked files`

## Firestore API Prerequisite
- In production mode, Firestore calls require the Cloud Firestore API to be enabled for `GOOGLE_CLOUD_PROJECT`.
- If disabled, `/health` will show:
  - `firestoreConfigured=true`
  - `firestoreRuntimeReady=false`
  - `firestoreLastError` with the permission detail.

## Local Port Note
- If backend startup fails with `EADDRINUSE: 8080 already in use`, another backend process is already running.
- Stop the existing process and run `npm run dev` again.

## Google Proof Paths
- Planner: [backend/src/actionPlanner.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/actionPlanner.ts)
- Live: [backend/src/liveSession.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/liveSession.ts)
- Vertex client: [backend/src/vertex.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/vertex.ts)
- Firestore repository: [backend/src/firestore.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/firestore.ts)
- Runtime diagnostics: [backend/src/routes/health.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/routes/health.ts)
