## Frontend Workspace

This folder contains:
- `sandbox-portal`: deterministic telehealth sandbox UI flow
- `extension`: Chrome Manifest V3 side panel navigator

## Sandbox Portal
Run:
```bash
npm run dev --workspace sandbox-portal
```

Flow steps (stable IDs):
- login
- appointments
- appointment details
- camera permission (simulated)
- microphone permission (simulated)
- pre-call device test
- waiting room
- joined call

Deterministic behavior notes:
- Stage order is linear and guarded: `login -> appointments -> appointment details -> camera -> microphone -> device test -> waiting room -> joined call`.
- `Restart Demo Flow` resets all inputs and returns to login for repeatable demo takes.
- Planner-relevant IDs for proven happy-path controls are preserved.

## Extension
Build:
```bash
npm run build --workspace extension
```

Load unpacked extension from `frontend/extension/dist`.

### Required MV3 capabilities used
- `sidePanel`
- `tabs`
- `activeTab`
- `scripting`
- host access via `<all_urls>`

### Side panel behavior
- Captures active tab context and a real screenshot for each happy-path planning request.
- Validates screenshot MIME and image bytes before planner/live submission.
- Sends multimodal payload to backend planner.
- Renders one grounded action at a time and executes safely.
- Logs executed action details (including target IDs).
- Provides live interaction controls using backend WebSocket (`start`, wait for `LIVE_READY`, text+image frame, end).
- Live state progression is explicit: `disconnected -> connecting -> socket connected (not ready) -> live ready`, with an `error` state for fatal start/runtime failures.
- `Send Text + Current Frame` is blocked until `LIVE_READY` is confirmed.

## Local End-to-End
1. Start backend (`backend/npm run dev`)
2. Start sandbox (`npm run dev --workspace sandbox-portal`)
3. Build extension (`npm run build --workspace extension`)
4. Load unpacked extension from `frontend/extension/dist`
5. Open sandbox in a tab and use side panel to run guided steps
