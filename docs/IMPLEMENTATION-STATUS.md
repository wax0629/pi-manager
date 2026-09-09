# Implementation Status

## Current slice

The project has moved from the React-only prototype to the first real vertical
slice:

```text
React provider cards
  -> /api/state
  -> persisted Pi Manager state

Add provider form
  -> /api/providers
  -> provider metadata + local credential storage

Edit custom provider form
  -> PATCH /api/providers/:id
  -> name / providerId / baseUrl / model list / optional API key

Model default controls and Thinking mapping
  -> /api/route + /api/models/thinking
  -> validated candidate route + capability-checked Thinking mapping

Cycle list editing
  -> /api/models/cycle
  -> ordered enabledModels injection with stale-ref validation
  -> provider catalog injection through profile models.json

Model context metadata editing
  -> /api/models/context-window
  -> validated contextWindow persistence and Pi models.json/extension injection

Profile apply/launch/stop/rollback
  -> /api/apply + /api/pi/launch + /api/pi/stop + /api/profile/rollback
  -> Pi-compatible isolated profile generation, direct models.json catalog injection, launch entry, stop control and last-applied snapshot restore

Provider connection testing
  -> /api/providers/:id/test
  -> single-action reachability probe with categorized failures

Pi native auth status
  -> provider-specific `pi auth check --provider`
  -> short-lived cached, credential-free status used by cards, route validation and connection tests
```

The implementation uses the existing card layout from the prototype as the
working UI. It does not fork Pi or modify the user's project `.pi` directory.

## Entry-page decision

For the current product iteration, `供应商与账号` is the default entry page,
following the Cockpit Tools style of putting the most frequent management task
first. The conceptual `总览` page remains in the product specification as a
future status surface, but it is not implemented as a separate first screen in
this slice.

This is an implementation decision, not a rewrite of the original prototype
specification. The prototype specification continues to describe the broader
MVP flow; later implementation slices must either add the overview or record a
new decision if the information is intentionally folded into the provider page.

## Included

- Read real provider, model, active-route, Pi, gateway and configuration status
  from `GET /api/state`.
- Show loading and recoverable error states in the web UI.
- Search provider cards and refresh the state from the backend.
- Add a custom OpenAI-compatible provider with one or more model IDs.
- Import existing OpenAI-compatible providers from the local Pi `models.json`
  without modifying the source file or writing plaintext keys into state.json.
- Edit an existing custom provider's name, provider ID, base URL, model list
  and optional API key, while preserving remaining model metadata.
- Save an optional API key through the existing credential abstraction without
  returning the key in API state.
- Configure or clear API keys for existing OpenAI-compatible and local-bridge
  providers from the provider cards. Native subscription providers stay on Pi login.
- Test provider connectivity from the provider cards with categorized failure
  messages.
- Detect each native provider's Pi authentication state independently and
  refresh it after the short cache window without exposing credentials; an
  explicit UI refresh or connection test forces a fresh probe.
- Keep provider cards focused on connection resources; configure the default
  provider, model and thinking level from the model resource page.
- Edit the Ctrl+P cycling list with ordered add/remove/reorder controls and
  persist it as enabledModels in the generated profile.
- Edit each complete-catalog model's context window and inject the value into
  the generated Pi model definition.
- Add or remove models in a custom provider's complete catalog, while cleaning
  cycle-list refs and refusing to delete the active default model.
- Edit thinking-level mappings with Pi-level vs upstream-value vs unsupported
  states, then persist them through the manager state and profile generator.
- Apply, launch, stop and roll back the isolated profile from the Profile page.
- Keep generated settings, models and launcher at the profile root expected by
  Pi's PI_CODING_AGENT_DIR, while preserving unrelated legacy files.
- Validate candidate routes against provider credentials, bridge status and
  model thinking capabilities before saving them.
- Track a minimal candidate revision and applied revision so the UI can
  distinguish unsaved candidate changes from the last applied profile.
- Serve `web/dist` from the Node server after a production build and proxy
  `/api` during Vite development.

## Deferred

- Pi-native OAuth/API login UI and auth import;
- profile diff preview and process ownership;
- real provider model discovery;
- Antigravity adapter.

## Verification

The slice is verified with:

```bash
npm run check
npm test
npm --prefix web run build
```

Manual verification also requires starting the Manager API and the Vite web
server, then adding a provider through the UI and confirming that a subsequent
refresh reads it from the persisted Manager state. Live Pi startup on this
machine is still gated on having the Pi executable available, so the native
profile handoff path remains runtime-verified rather than fully exercised here.
