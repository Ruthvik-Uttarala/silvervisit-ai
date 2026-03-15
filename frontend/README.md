## Frontend Workspace

Contains:
- `sandbox-portal`: deterministic telehealth sandbox (data from backend Firestore routes)
- `extension`: MV3 side panel UI Navigator

## Extension UX
- Default surface is intentionally simple:
  - branded header
  - one goal composer
  - inline mic button
  - one primary CTA (`Run One Grounded Step`)
  - concise progress feed
- Technical diagnostics/live raw logs are in **Developer Details** (collapsed by default).

## Mic + Goal Behavior
- Inline mic starts real `getUserMedia` capture.
- Audio is converted to PCM16 mono 16kHz and streamed to backend `/api/live`.
- Browser speech recognition helper updates goal text while speaking (UX assist only).
- User can edit goal text before tapping the primary CTA.

## One-Turn Contract
- One primary CTA click:
  - one coordinated screenshot capture
  - one planner request
  - at most one grounded action execution
- Duplicate submit protections:
  - in-flight lock
  - cooldown
  - deduped live message IDs
  - background screenshot capture guard

## Sandbox
- Fetches fixture/run context from backend routes:
  - `POST /api/sandbox/run/start`
  - `POST /api/sandbox/run/event`
- Stable IDs and linear flow preserved.
- Visible persona/appointment data varies deterministically by seed.
- Realism upgrade coverage:
  - multi-section portal navigation (dashboard, upcoming, past, details, eCheck-In, device setup, waiting room, help, after-visit)
  - time-aware appointment cards with join-window metadata
  - adversarial same-day ambiguity in seeded fixtures
  - support/caregiver return paths
  - below-the-fold required tasks to force grounded scrolling behavior
