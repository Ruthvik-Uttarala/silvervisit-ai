# SilverVisit YC Demo Runbook

## Production Targets

- Frontend project: `silvervisit-ai`
- Backend project: `silvervisit-api`
- Supabase organization: `Uttarala Ruthvik Org`
- Supabase project: `SilverVisit`
- Supabase ref: `veeivhmjobehdjwnrzec`
- Seed: `2`
- Typed goal: `Help me join my doctor appointment today.`

## Required Backend Environment Variable Names

- `AI_PROVIDER`
- `GEMINI_API_KEY`
- `GEMINI_ACTION_MODEL`
- `ENABLE_LIVE_API`
- `PERSISTENCE_PROVIDER`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`
- `NODE_ENV`

Expected non-secret values:

- `AI_PROVIDER=gemini_api`
- `GEMINI_ACTION_MODEL=gemini-2.5-flash`
- `ENABLE_LIVE_API=false`
- `PERSISTENCE_PROVIDER=supabase`
- `NODE_ENV=production`

## Required Frontend/Extension Environment Variable Names

- `VITE_BACKEND_BASE_URL`
- `VITE_SUPPORTED_PORTAL_ORIGINS`

## Extension Build

```powershell
npm run build --workspace extension
```

Load unpacked extension from:

```text
frontend/extension/dist
```

Expected files:

- `manifest.json`
- `sidepanel.html`
- `assets/background.js`
- `assets/content.js`
- side-panel assets under `assets/`

## Pre-Recording Checklist

- Production frontend opens with `?seed=2`.
- `/health` reports `aiProvider: gemini_api`, `geminiConfigured: true`, `liveEnabled: false`, `databaseProvider: supabase`, and `supabaseConfigured: true`.
- `GET /api/sandbox/fixture?seed=2` returns fictional fixture data.
- `POST /api/session/start` persists a Supabase session.
- `POST /api/plan-action` calls real Gemini Developer API and returns a validated grounded action.
- Browser bundle search has no `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or key-like `AIza` value.
- Extension recognizes only the configured production portal origin.
- Unsupported websites are refused.

## 60-90 Second Demo Flow

1. Open the production fictional portal at `?seed=2`.
2. Say older adults often struggle to identify and join the right telehealth appointment.
3. Open the SilverVisit side panel.
4. Enter `Help me join my doctor appointment today.`
5. Show SilverVisit reading the page and choosing one grounded action.
6. Let the extension select the correct current appointment.
7. Continue one safe step at a time through eCheck-In and device setup.
8. Reach the waiting room or joined state.
9. Open an unsupported page and show SilverVisit refusing to act.
10. Return to the SilverVisit portal and show recovery.

## Typed Fallback

Voice is optional for this build. If microphone or live voice is unavailable, use only the typed goal box in the side panel. The typed flow is the required demo path.

## Known Limitations

- Voice/Gemini Live is intentionally disabled for deadline reliability.
- All healthcare data is fictional and synthetic.
- The extension must be loaded manually as an unpacked production build.

## Recovery Steps

- If the extension refuses the page, return to the configured production portal origin.
- If the backend reports missing configuration, verify server-side environment variable names and redeploy `silvervisit-api`.
- If Gemini returns quota or authentication errors, rotate or restore the server-side `GEMINI_API_KEY` in Vercel and redeploy the backend.
- If Supabase persistence fails, verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the backend project only.
