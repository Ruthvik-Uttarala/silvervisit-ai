# SilverVisit AI Backend

Production-style backend for the SilverVisit AI UI Navigator agent. This service analyzes browser page context (DOM-like element map + visible text + screenshot frames), asks Gemini on Vertex AI for the single best next UI action, returns grounded executable JSON, and provides a live WebSocket route for real-time Gemini Live interaction.

## Why This Exists
Older adults can get blocked in telehealth flows (check-in forms, consent screens, join buttons). The backend gives the Chrome extension a safe, grounded next action without guessing hidden UI and supports a demo-ready real-time assistant route.

## Architecture Summary
- Node.js 20 + TypeScript + built-in `http` server (no Express/FastAPI).
- `POST /api/plan-action` validates input, sends multimodal context to Gemini (`gemini-2.5-flash`) using `@google/genai` on Vertex AI, and enforces strict post-model guardrails.
- `WS /api/live` handles `start`, `user_text`, `user_image_frame`, `user_audio_chunk`, `end` and forwards text/image turns to Gemini Live when enabled.
- In-memory session store with bounded history + TTL cleanup (no database).
- Structured logging with redaction (base64 and sensitive blobs are never logged raw).
- Cloud Run-ready image build + deploy script + Cloud Build config.

## Routes
### `GET /health`
Returns:
```json
{
  "ok": true,
  "service": "silvervisit-backend",
  "liveApiConfigured": false,
  "vertexConfigured": true
}
```

### `POST /api/session/start`
Request:
```json
{ "userGoal": "Join my telehealth visit" }
```
Response:
```json
{ "sessionId": "uuid", "createdAt": "ISO-8601" }
```

### `POST /api/plan-action`
Accepts structured page state + optional screenshot/frame base64 and returns the required action schema with grounding.

### `WS /api/live`
Client message types:
- `start`
- `user_text`
- `user_audio_chunk`
- `user_image_frame`
- `end`

Server message types:
- `model_text`
- `transcript`
- `planned_action`
- `tool_call`
- `error`

## Environment Variables
Required for real Vertex calls:
- `GOOGLE_GENAI_USE_VERTEXAI=true`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION` (default: `global`)

Optional:
- `GEMINI_ACTION_MODEL` (default `gemini-2.5-flash`)
- `GEMINI_LIVE_MODEL` (default `gemini-live-2.5-flash-native-audio`)
- `ENABLE_LIVE_API` (default `false`)
- `PORT` (default `8080`)

Copy template:
```bash
cp .env.example .env
```

## Local Setup
```bash
cd backend
npm install
```

If you want real Vertex AI calls locally:
```bash
gcloud auth application-default login
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT
export GOOGLE_CLOUD_LOCATION=global
```

## Run Locally
```bash
npm run dev
```

Production-style local run:
```bash
npm run build
npm run start
```

## Smoke Tests
```bash
npm run smoke
```

Smoke test coverage:
- boots local server
- validates `/health`
- validates `/api/session/start`
- validates `/api/plan-action` schema and guardrails
- sends a real screenshot fixture (`fixtures/sample-screenshot.png`) in planning payload
- tests WebSocket `/api/live` message flow for `start`, `user_text`, `user_image_frame`, `user_audio_chunk`
- attempts real Vertex planning call when env + ADC are present
- otherwise prints exact missing env/ADC guidance and still validates fallback behavior

Demo requirement note:
- The primary SilverVisit happy path should send a real screenshot on every planning step from the extension.
- DOM-only planner calls should be treated as fallback/non-happy-path behavior.

## Example curl Commands
Start session:
```bash
curl -s -X POST http://localhost:8080/api/session/start \
  -H 'Content-Type: application/json' \
  -d '{"userGoal":"Join my telehealth visit"}'
```

Plan action (with fixture payload):
```bash
curl -s -X POST http://localhost:8080/api/plan-action \
  -H 'Content-Type: application/json' \
  --data-binary @fixtures/sample-plan-request.json
```

Health:
```bash
curl -s http://localhost:8080/health
```

## WebSocket Usage Example
Using any WS client to `ws://localhost:8080/api/live`:

1. Send start:
```json
{"type":"start","sessionId":"demo-live-1","userGoal":"Help me join my visit"}
```
2. Send text:
```json
{"type":"user_text","text":"I cannot find the join button"}
```
3. Send image frame:
```json
{"type":"user_image_frame","mimeType":"image/png","dataBase64":"..."}
```
4. Optional audio chunk (returns structured unsupported message unless PCM framing contract is provided):
```json
{"type":"user_audio_chunk","mimeType":"audio/pcm","dataBase64":"..."}
```
5. End session:
```json
{"type":"end"}
```

## Live Mode Notes
- If `ENABLE_LIVE_API=false`, route remains available and responds with structured `error` messages.
- If enabled but Vertex/ADC is missing, route returns structured `error` with remediation hints.
- Demo-usable live path implemented: text + image input and model text output via Gemini Live.

## Cloud Run Deployment
### Option 1: Scripted deploy
```bash
cd backend
./scripts/deploy-cloud-run.sh \
  --service silvervisit-backend \
  --project YOUR_PROJECT_ID \
  --region us-central1 \
  --env GOOGLE_GENAI_USE_VERTEXAI=true \
  --env GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID \
  --env GOOGLE_CLOUD_LOCATION=global \
  --env GEMINI_ACTION_MODEL=gemini-2.5-flash \
  --env GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio \
  --env ENABLE_LIVE_API=true
```

### Option 2: Cloud Build
```bash
cd backend
gcloud builds submit --config cloudbuild.yaml
```

## Verify Deployment
```bash
SERVICE_URL=$(gcloud run services describe silvervisit-backend --region us-central1 --format='value(status.url)')
curl -s "$SERVICE_URL/health"
```

## Cloud Run WebSocket Caveats
- Cloud Run supports WebSockets.
- Cloud Run request timeout still applies to long-lived WS connections.
- Clients should reconnect cleanly when a socket drops.
- Session affinity is optional for multi-instance behavior, but this backend uses in-memory session state so affinity can improve continuity during demos.
- End-to-end HTTP/2 is not required for Cloud Run WebSocket operation.

## Challenge Rubric Mapping
This backend explicitly satisfies:
- Gemini model usage on Vertex AI (`gemini-2.5-flash` and `gemini-live-2.5-flash-native-audio`)
- Google Gen AI SDK usage (`@google/genai`)
- Gemini multimodal screenshot understanding (inline image + frame support)
- Executable action output in strict JSON schema
- Google Cloud deployment target (Cloud Run + Docker + Cloud Build)
- Live API usage in demo path (text/image in, model text out)
- Reproducible setup (`npm install`, `npm run build`, `npm run smoke`, deploy script)

## Judge Quickstart (Exact Commands)
```bash
git clone <repo>
cd silvervisit-ai/backend
npm install
npm run build
npm run smoke
npm run dev
curl -s http://localhost:8080/health
```
