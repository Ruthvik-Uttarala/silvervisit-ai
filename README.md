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

## Pre-Phase 5 Realism Notes
- Sandbox is now a multi-section telehealth portal with:
  - `Dashboard`
  - `Upcoming Appointments`
  - `Past Appointments`
  - `Appointment Details`
  - `eCheck-In`
  - `Device Setup`
  - `Virtual Waiting Room`
  - `Reports / Results`
  - `Notes / AVS`
  - `Messages`
  - `Prescriptions`
  - `Referrals`
  - `Help / Support`
  - `After Visit Summary`
- Backend intent extraction is lightweight and generic (no phrase whitelist):
  - destination (`appointments`, `reports_results`, `notes_avs`, `messages`, `prescriptions`, `referrals`, `help`)
  - user-provided identity (`name`, `DOB`)
  - provider/specialty/topic/time cues
- User-provided name and DOB are preferred for grounded form typing; conflicting identity triggers clarification instead of silent substitution.
- Appointment disambiguation is deterministic and time-aware via fixture fields:
  - `portalNow`
  - `scheduledDateTime`
  - `joinWindowStart`
  - `joinWindowEnd`
  - `status`
  - `joinableNow`
- Seeds `2` and `4` include adversarial ambiguity:
  - multiple same-day appointments
  - similar provider names
  - one past/completed lookalike
  - one not-yet-joinable card
  - one joinable-now card
- Below-the-fold required actions are intentionally present in eCheck-In and device setup to require grounded scrolling.
- Help/caregiver support paths are real navigable flows:
  - Need help joining
  - Invite caregiver
  - Call clinic
  - Troubleshoot device
  - Return to appointment

## Build and Verification
Run:
```bash
npm run build --workspace extension
npm run build --workspace sandbox-portal
cd backend && npm run build
cd backend && npm run smoke
```

## Cloud Run Deploy (Copy/Paste)
Locked runtime contract:
- service: `silvervisit-backend`
- region: `us-central1`
- auth: `allow-unauthenticated`
- timeout: `900s`
- port: `8080`
- contract file: [backend/deploy/cloud-run.contract.json](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/deploy/cloud-run.contract.json)

Deploy and verify:
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

Direct deployed verifier run (if you already have a URL):
```bash
cd backend
npm run verify:cloud-run -- \
  --base-url https://YOUR_SERVICE_URL.run.app \
  --service silvervisit-backend \
  --region us-central1 \
  --project YOUR_GCP_PROJECT
```

Verifier output is judge-ready and includes:
- deployed base URL, service, region
- anonymous reachability proof (`GET /health` without auth)
- Vertex/Gemini/Firestore runtime truth fields from `/health`
- `/api/session/start` and `/api/plan-action` results
- `/api/live` contract probe (`live_ready` or explicit live blocker)
- deployed timeout verification (`900s`)
- Node timeout diagnostics (`httpRequestTimeoutMs`, `httpHeadersTimeoutMs`, `httpKeepAliveTimeoutMs`)
- explicit remaining manual browser proof step if live audio E2E is not possible from CLI

## Google Stack Evidence
- **Planner call site**
  - [backend/src/actionPlanner.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/actionPlanner.ts)
  - Uses `client.models.generateContent` from `@google/genai` with Vertex config.
- **Intent extraction**
  - [backend/src/intentParser.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/src/intentParser.ts)
  - Generic parser for destination, temporal cues, provider/topic, and user identity fields.
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
  - [backend/scripts/deploy-cloud-run.ps1](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/scripts/deploy-cloud-run.ps1)
  - [backend/scripts/verify-cloud-run.ts](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/scripts/verify-cloud-run.ts)
  - [backend/deploy/cloud-run.contract.json](/c:/Users/RUTHVIK/Downloads/silvervisit-ai/backend/deploy/cloud-run.contract.json)
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
- Deployment fails with auth errors:
  - run `gcloud auth application-default login`
  - verify required APIs are enabled: `run`, `cloudbuild`, `artifactregistry`, `aiplatform`, `firestore`
- Secret hygiene check:
  - run `cd backend && npm run secret:hygiene`
- Mic denied:
  - allow extension microphone permission and retry.
- Unsupported page warning:
  - open the sandbox tab (`localhost` or SilverVisit sandbox host) before running.
