# SilverVisit AI

SilverVisit AI is a real UI Navigator submission for the Gemini Live Agent Challenge.  
It combines screenshot-grounded UI navigation, real live microphone ingestion, and Firestore-backed deterministic sandbox data.

## Judge Quickstart
1. Install dependencies:
```bash
npm install
cd backend && npm install && cd ..
```
2. Configure backend env:
```bash
cd backend
cp .env.example .env
```
3. Set required env in `backend/.env`:
```bash
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_ACTION_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
ENABLE_LIVE_API=true
ENABLE_FIRESTORE=true
FIRESTORE_COLLECTION_PREFIX=silvervisit
```
4. Authenticate ADC (Vertex + Firestore production mode):
```bash
gcloud auth application-default login
```
5. Optional local Firestore emulator mode:
```bash
gcloud beta emulators firestore start --host-port=127.0.0.1:8086
```
Then set:
```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8086
```
6. Start backend:
```bash
cd backend
npm run dev
```
7. Start sandbox:
```bash
npm run dev --workspace sandbox-portal
```
8. Build extension and load unpacked from `frontend/extension/dist`:
```bash
npm run build --workspace extension
```
9. Open sandbox (`http://localhost:4173/?seed=2` for deterministic seeded run), open side panel, use inline mic in composer, then click the single primary CTA.

## Proof Checklist
- One default assistant surface with one primary CTA and inline mic.
- Developer details are hidden by default under a collapsible drawer.
- One CTA click performs one coordinated screenshot-grounded action turn.
- Live audio chunks come from real `getUserMedia` microphone capture (no probe payloads).
- Sandbox identity data is fetched from backend Firestore fixture records by deterministic seed.
- `/health` shows Vertex, Live, and Firestore diagnostics.
- Planner and live routes use `@google/genai` on Vertex AI.

## Architecture
- Diagram source: [docs/architecture.mmd](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/docs/architecture.mmd)
- Components:
  - `frontend/extension`: MV3 side panel + background + content script
  - `frontend/sandbox-portal`: deterministic telehealth UI with stable IDs
  - `backend`: Node.js + TypeScript API + WS proxy + Firestore repository

## Deterministic Sandbox Behavior
- Stable IDs and linear flow remain fixed.
- Visible fixture content varies deterministically by seed:
  - patient identity
  - DOB
  - login secret
  - doctor name
  - appointment details
  - waiting/joined status text
- Restart increments seed deterministically.

## Build and Verification
Run:
```bash
npm run build --workspace extension
npm run build --workspace sandbox-portal
cd backend && npm run build
cd backend && npm run smoke
```

## Google Stack Evidence
- **Planner call site**
  - [backend/src/actionPlanner.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/actionPlanner.ts)
  - Uses `client.models.generateContent` from `@google/genai` with Vertex config.
- **Live call site**
  - [backend/src/liveSession.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/liveSession.ts)
  - Uses `client.live.connect` and forwards realtime `user_audio_chunk` / `audioStreamEnd`.
- **Vertex client setup**
  - [backend/src/vertex.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/vertex.ts)
  - Constructs `GoogleGenAI({ vertexai: true, project, location })`.
- **Runtime diagnostics**
  - `GET /health` from [backend/src/routes/health.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/routes/health.ts)
  - Includes `useVertexAI`, `vertexConfigured`, `liveEnabled`, `liveApiConfigured`, model names, Firestore mode/config.
- **Cloud Run deploy proof**
  - [backend/cloudbuild.yaml](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/cloudbuild.yaml)
  - [backend/scripts/deploy-cloud-run.sh](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/scripts/deploy-cloud-run.sh)
  - [backend/Dockerfile](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/Dockerfile)

## Firestore Evidence
- **Collections used**
  - `sandboxFixtures`
  - `sandboxRuns`
  - `navigatorSessions`
  - `liveEvents`
  - `actionLogs`
- **Repository**
  - [backend/src/firestore.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/firestore.ts)
- **Seed/bootstrap script**
  - `cd backend && npm run seed:firestore`
  - Script: [backend/scripts/seed-firestore.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/scripts/seed-firestore.ts)
- **Route mapping**
  - `GET /api/sandbox/fixture` reads fixture by seed.
  - `POST /api/sandbox/run/start` creates run + resolves fixture.
  - `POST /api/sandbox/run/event` updates run progression.
  - `POST /api/session/start` upserts navigator session.
  - `POST /api/plan-action` records action log.
  - `WS /api/live` records live lifecycle events.

## Troubleshooting
- `live_not_configured`:
  - check `ENABLE_LIVE_API=true` and Vertex env values.
- Firestore route failures:
  - set `ENABLE_FIRESTORE=true` and either `FIRESTORE_EMULATOR_HOST` or valid ADC + `GOOGLE_CLOUD_PROJECT`.
  - if production mode returns `PERMISSION_DENIED` for Firestore API, enable:
    - `firestore.googleapis.com` for your project.
- Mic denied:
  - allow extension microphone permission and retry.
- Unsupported page warning:
  - open the sandbox tab (`localhost` or SilverVisit sandbox host) before running.
