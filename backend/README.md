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

## Firestore API Prerequisite
- In production mode, Firestore calls require the Cloud Firestore API to be enabled for `GOOGLE_CLOUD_PROJECT`.
- If disabled, `/health` will show:
  - `firestoreConfigured=false`
  - `firestoreRuntimeReady=false`
  - `firestoreLastError` with the permission detail.

## Google Proof Paths
- Planner: [backend/src/actionPlanner.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/actionPlanner.ts)
- Live: [backend/src/liveSession.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/liveSession.ts)
- Vertex client: [backend/src/vertex.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/vertex.ts)
- Firestore repository: [backend/src/firestore.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/firestore.ts)
- Runtime diagnostics: [backend/src/routes/health.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/routes/health.ts)
