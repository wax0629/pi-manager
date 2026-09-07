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

Model default controls
  -> /api/route
  -> validated candidate route
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
- Save an optional API key through the existing credential abstraction without
  returning the key in API state.
- Keep provider cards focused on connection resources; configure the default
  provider, model and thinking level from the model resource page.
- Validate candidate routes against provider credentials, bridge status and
  model thinking capabilities before saving them.
- Track a minimal candidate revision and applied revision so the UI can
  distinguish unsaved candidate changes from the last applied profile.
- Serve `web/dist` from the Node server after a production build and proxy
  `/api` during Vite development.

## Deferred

- Pi-native OAuth PTY flow;
- cycling-list ordering and thinking-map editing;
- profile diff preview, rollback and process ownership;
- real provider connection tests and model discovery;
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
refresh reads it from the persisted Manager state.
