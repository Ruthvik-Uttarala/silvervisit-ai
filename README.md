# SilverVisit AI

SilverVisit AI is a UI Navigator demo for older adults joining telehealth visits.

It includes:
- `frontend/sandbox-portal`: deterministic telehealth web flow (login to joined call)
- `frontend/extension`: Chrome MV3 side panel agent that captures screen context, sends multimodal planning requests, and executes grounded actions
- `backend`: Node.js + TypeScript backend on Vertex AI (`@google/genai`) with Gemini action planning and Gemini Live WebSocket support

## Architecture
- The extension captures URL, title, visible text, actionable elements, and a real screenshot from the active tab.
- The extension sends the planning payload to `POST /api/plan-action`.
- Backend returns exactly one grounded next action.
- Extension highlights or executes the action safely (`highlight`, `click`, `type`, `scroll`, `wait`).
- Live demo path uses `WS /api/live` with text + current image frame in the same session.

## Prerequisites
- Node.js 20 (Vite 7 recommends Node 20.19+)
- npm
- Chrome (for loading the extension)
- For real Gemini calls: Vertex env vars + ADC

## Install
```bash
npm install
cd backend && npm install && cd ..
```

## Run Locally
Terminal 1 (backend):
```bash
cd backend
cp .env.example .env
# Set GOOGLE_CLOUD_PROJECT=silvervisit-ai, GOOGLE_CLOUD_LOCATION=us-central1, ENABLE_LIVE_API=true
gcloud auth application-default login
npm run dev
```

Terminal 2 (sandbox):
```bash
npm run dev:sandbox
```

Terminal 3 (extension build):
```bash
npm run build:extension
```

Load extension in Chrome:
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked: `frontend/extension/dist`
4. Open the side panel via extension action
5. Open sandbox at `http://localhost:4173`

## Demo Flow
1. In side panel, enter goal (for example: "Help me join my doctor appointment").
2. Click `Run Next Step (Screenshot Required)` repeatedly.
3. Confirm transcript logs include captured screenshot and executed action details.
4. Verify at least one grounded `type` and one grounded `click` execution in the sandbox flow.
5. Complete flow from login to waiting room or joined call.

## Live Demo Flow
1. In side panel, click `Start Live`.
2. Wait for the live transcript to show `LIVE_READY`.
3. Click `Send Text + Current Frame` to send a text turn and image frame in one live session.
4. Confirm model/transcript responses appear.
5. Optional: click `Send Audio Probe` to verify graceful structured unsupported-audio handling.

## Build and Checks
Root frontend builds:
```bash
npm run build
```

Backend checks:
```bash
cd backend
npm run build
npm run smoke
```

## Cloud Deployment
Backend Cloud Run deployment details are in [backend/README.md](backend/README.md).

## External Blockers
Only true external blockers should remain:
- Missing Vertex credentials/ADC
- Docker daemon unavailable (for container build/run)
- Chrome runtime permission grant constraints
