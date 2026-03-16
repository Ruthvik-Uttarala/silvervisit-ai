# SilverVisit AI
SilverVisit AI is a Chrome Extension UI Navigator that helps older adults complete confusing telehealth portal tasks safely. It listens to typed or spoken goals, grounds each step in the visible screen, executes one action at a time, and keeps navigation constrained to supported telehealth pages with clear safety guardrails.

## Why This Project Is Special
- Multimodal UI navigation: user goal + screenshot/page context drive grounded next actions.
- Real-time live interaction: Gemini Live path supports voice-driven help during navigation.
- Safety-first execution: one grounded action per turn, with hidden/disabled/invalid target protections.
- Telehealth-only guardrails: unsupported pages are blocked with explicit guidance.
- Real Google Cloud evidence: Cloud Run backend, Vertex Gemini runtime, and Firestore-backed fixture/session traces.

## Judge Quick Start
- Fastest understanding path: read `## Exact Demo Runbook (Fastest Path)` below and execute top-to-bottom.
- Backend code: `backend/`
- Extension code: `frontend/extension/`
- Sandbox telehealth portal: `frontend/sandbox-portal/`
- Google Cloud proof files: `backend/cloudbuild.yaml`, `backend/scripts/deploy-cloud-run.ps1`, `backend/scripts/verify-cloud-run.ts`, `backend/deploy/cloud-run.contract.json`
- Architecture source: `docs/architecture.mmd`


## Credentials Note

This repository does not include private API keys or service account secrets.

### Hosted judge path
Judges can verify the project without private credentials by using:
- the public code repository
- the deployed Cloud Run backend
- the `/health` endpoint
- the demo video
- the Google Cloud deployment proof links in this README

### Local reproduction path
Running the backend locally requires your own Google Cloud project and authentication via Application Default Credentials (ADC) for Vertex AI and Firestore.

This is intentional for security: private keys are never committed to the repository.

## Exact Demo Runbook (Fastest Path)
Recommended path: **PowerShell deploy script** `backend/scripts/deploy-cloud-run.ps1`.

1. **Folder:** repo root  
   **Command:** `npm install`  
   **Expected success result:** dependency install completes with no fatal errors.

2. **Folder:** `backend/`  
   **Command:** `Copy-Item .env.example .env -Force`  
   **Expected success result:** `backend/.env` exists.

3. **Folder:** `backend/`  
   **Command:**  
   ```powershell
   @'
   GOOGLE_GENAI_USE_VERTEXAI=true
   GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT
   GOOGLE_CLOUD_LOCATION=us-central1
   GEMINI_ACTION_MODEL=gemini-2.5-flash
   GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
   ENABLE_LIVE_API=true
   ENABLE_FIRESTORE=true
   FIRESTORE_COLLECTION_PREFIX=silvervisit
   HTTP_REQUEST_TIMEOUT_MS=0
   HTTP_HEADERS_TIMEOUT_MS=70000
   HTTP_KEEPALIVE_TIMEOUT_MS=65000
   '@ | Set-Content .env
   ```  
   **Expected success result:** `backend/.env` contains the required runtime keys.

4. **Folder:** any terminal  
   **Command:**  
   ```powershell
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project YOUR_GCP_PROJECT
   ```  
   **Expected success result:** gcloud account is authenticated and project is set.

5. **Folder:** `backend/`  
   **Command:**  
   ```powershell
   .\scripts\deploy-cloud-run.ps1 `
     -Service silvervisit-backend `
     -Project YOUR_GCP_PROJECT `
     -Region us-central1 `
     -Location us-central1 `
     -TimeoutSeconds 900
   ```  
   **Expected success result:** deploy completes and prints deployed service URL.

6. **Folder:** `backend/`  
   **Command:**  
   ```powershell
   npm run verify:cloud-run -- `
     --base-url https://YOUR_CLOUD_RUN_URL.run.app `
     --service silvervisit-backend `
     --region us-central1 `
     --project YOUR_GCP_PROJECT
   ```  
   **Expected success result:** verifier reports deployed checks passed (or explicit live warning with manual browser step).

7. **Folder:** `frontend/extension/`  
   **Command:**  
   ```powershell
   "VITE_BACKEND_BASE_URL=https://YOUR_CLOUD_RUN_URL.run.app" | Set-Content .env.production
   ```  
   **Expected success result:** extension production env points to deployed Cloud Run backend.

8. **Folder:** repo root  
   **Command:** `npm run build --workspace extension`  
   **Expected success result:** extension build completes and `frontend/extension/dist` is generated.

9. **Folder:** repo root  
   **Command:** `npm run build --workspace sandbox-portal`  
   **Expected success result:** sandbox build completes successfully.

10. **Folder:** `frontend/extension/dist`  
    **Command:** `start chrome://extensions`  
    **Expected success result:** Chrome extensions page opens; load unpacked extension from `frontend/extension/dist`.

11. **Folder:** repo root  
    **Command:** `npm run dev --workspace sandbox-portal -- --host 127.0.0.1 --port 4173`  
    **Expected success result:** sandbox runs locally and `http://127.0.0.1:4173/?seed=2` is available.

12. **Folder:** browser (sandbox + sidepanel)  
    **Command:** use sidepanel with goal: `Help me join my appointment today.`  
    **Expected success result:** sidepanel shows deployed backend URL, executes grounded steps, and demo recording can start.

## Pre-Recording Checklist
- `https://YOUR_CLOUD_RUN_URL.run.app/health` returns `ok: true`.
- Extension sidepanel shows `Backend: https://YOUR_CLOUD_RUN_URL.run.app`.
- Unsupported-page guard is visible on a non-telehealth tab and clears on return to sandbox.
- Supported sandbox flow runs from sidepanel on `http://127.0.0.1:4173/?seed=2`.
- Architecture diagram source `docs/architecture.mmd` is present in repo.

## If Something Fails
- **gcloud auth/project mismatch**  
  Fastest fix: rerun `gcloud auth login`, `gcloud auth application-default login`, `gcloud config set project YOUR_GCP_PROJECT`.
- **Required Google APIs not enabled**  
  Fastest fix: enable `run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `aiplatform.googleapis.com`, `firestore.googleapis.com`.
- **Extension still calling localhost backend**  
  Fastest fix: rewrite `frontend/extension/.env.production` with Cloud Run URL and rebuild extension.
- **Firestore runtime not ready in `/health`**  
  Fastest fix: grant Firestore permissions to the active runtime principal and rerun cloud verifier.
- **Live appears idle/disconnected**  
  Fastest fix: open supported sandbox tab and start mic/live; on unsupported tabs, live intentionally stays idle.

## Architecture Overview
- **Chrome MV3 Extension (`frontend/extension`)**: sidepanel UX + grounded turn orchestration + safe action dispatch.
- **Sandbox Telehealth Portal (`frontend/sandbox-portal`)**: deterministic, realistic telehealth UI paths for navigation.
- **Cloud Run Backend (`backend`)**: planner/session/sandbox/live routes, health diagnostics, deployment scripts.
- **Vertex Gemini Planner**: screenshot-grounded planning via `@google/genai` in Vertex mode.
- **Gemini Live Path**: websocket route for live start/ready and multimodal runtime events.
- **Firestore Persistence**: deterministic fixtures + run/session/action/live evidence.
- **Diagram source:** `docs/architecture.mmd`

## How It Works
1. User types or speaks a telehealth goal in the sidepanel.
2. Extension captures current page context and screenshot.
3. Backend plans the next action with Gemini on Vertex AI.
4. Extension executes one grounded action safely.
5. Session/run/live evidence is recorded through backend + Firestore paths.

## Tech Stack
- TypeScript
- Node.js
- React
- Vite
- Chrome Extension MV3
- Google GenAI SDK (`@google/genai`)
- Gemini 2.5 Flash
- Gemini Live API
- Google Cloud Run
- Vertex AI
- Cloud Firestore

## Google Cloud + Gemini Proof
- Gemini planner call site: `backend/src/actionPlanner.ts`
- Gemini Live call site: `backend/src/liveSession.ts`
- Vertex client configuration: `backend/src/vertex.ts`
- Firestore repository: `backend/src/firestore.ts`
- Cloud Run deployment automation: `backend/cloudbuild.yaml`, `backend/scripts/deploy-cloud-run.ps1`, `backend/scripts/deploy-cloud-run.sh`
- Deployed runtime verifier: `backend/scripts/verify-cloud-run.ts`
- Health diagnostics route: `backend/src/routes/health.ts`
- Deployment contract manifest: `backend/deploy/cloud-run.contract.json`

## Local Reproduction (Requires Your Own Google Cloud Credentials)
1. Install dependencies: `npm install`
2. Build extension: `npm run build --workspace extension`
3. Build sandbox: `npm run build --workspace sandbox-portal`
4. Build backend: `cd backend && npm run build`
5. Run backend smoke: `cd backend && npm run smoke`
6. Verify health endpoint: open `https://YOUR_CLOUD_RUN_URL.run.app/health`
7. Run one demo goal in sidepanel on seed 2 sandbox.

## Cloud Deployment
- Recommended deploy automation entry point: `backend/scripts/deploy-cloud-run.ps1`
- Cloud Build definition: `backend/cloudbuild.yaml`
- Runtime contract: `backend/deploy/cloud-run.contract.json`
- Deployed verification entry point: `backend/scripts/verify-cloud-run.ts`
- Canonical verification command:
  ```powershell
  cd backend
  npm run verify:cloud-run -- `
    --base-url https://YOUR_CLOUD_RUN_URL.run.app `
    --service silvervisit-backend `
    --region us-central1 `
    --project YOUR_GCP_PROJECT
  ```

## Demo / Submission Checklist
- Backend deployed on Cloud Run.
- `/health` is green and shows Vertex/Live/Firestore truth fields.
- Extension production env points to Cloud Run backend.
- Sandbox + extension demo flow works on supported telehealth page.
- Architecture diagram source included (`docs/architecture.mmd`).
- Cloud deployment automation files included and linked.

## Known Limitations / Next Steps
- Live end-to-end mic quality still depends on browser permissions and local device audio setup.
- Full live browser interaction remains a manual validation step even with deployed CLI verification.
- Future work: broader accessibility polish and additional guided recovery prompts for edge cases.

## Devpost Submission Links
- Public code repo: https://github.com/Ruthvik-Uttarala/silvervisit-ai
- Google Cloud deployment proof (paste as GitHub blob links):
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/cloudbuild.yaml`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/src/routes/health.ts`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/src/vertex.ts`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/src/firestore.ts`
- Automating Cloud Deployment bonus proof (paste as GitHub blob links):
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/scripts/deploy-cloud-run.ps1`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/scripts/deploy-cloud-run.sh`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/scripts/verify-cloud-run.ts`
  - `https://github.com/Ruthvik-Uttarala/silvervisit-ai/blob/main/backend/deploy/cloud-run.contract.json`
