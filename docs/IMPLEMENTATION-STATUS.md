# Implementation Status

Current product path (2026-09-10):

```text
供应商与账号
  -> 新增 OpenAI 兼容渠道 / 勾选导入本机 Pi / 原生登录
  -> 可选 GET /models 发现并勾选模型

模型资源库
  -> 完整目录、循环列表、默认模型、Thinking、Context

导入本机 Pi
  -> 备份 ~/.pi/agent
  -> 合并写入 settings.json / models.json / auth.json
  -> 退出当前 Pi 再进后生效
```

Does not fork Pi. Does not modify a user's project `.pi`.

## Included

- Read provider, model, route, Pi and gateway status from `GET /api/state`.
- Empty start: no seed providers, cycle, or active route.
- Add / edit / delete custom OpenAI-compatible providers.
- Fetch an upstream OpenAI `/models` catalog during setup; search, edit,
  select and save. Retry `/v1/models` when the root path returns HTML or 404.
- Import existing OpenAI-compatible providers from local Pi `models.json`
  after explicit checkbox selection. Keys stay out of `state.json`.
- Configure or clear API keys for OpenAI-compatible and local-bridge cards.
  Native subscriptions stay on Pi login (`ModelRuntime` → `~/.pi/agent/auth.json`).
- Test provider connectivity with categorized, sanitized failures.
- Edit the complete catalog, Ctrl+P cycle list, default route, thinking map
  and context window as candidate config.
- Import candidate config into `~/.pi/agent` after a Manager-owned backup,
  verify with `pi --list-models --offline`, and roll back from that backup.
- Serve `web/dist` from the Node server; Vite proxies `/api` in development.
- CLI entry `pi-manager` / `npx pi-manager` starts the API, serves `web/dist`,
  and opens the browser. Occupied ports reopen the existing instance.

## Removed from the UI

Isolated profile apply / launch / stop / rollback. Daily path is live import.
Backend endpoints still exist and are leftover cleanup.

## Deferred

- strip isolated profile backend (`/api/apply`, launch, stop);
- npm publish (the unscoped `pi-manager` name was unpublished in 2022);
- listing on pi.dev/packages (that gallery is extensions/skills/themes only);
- automatic background catalog refresh;
- Antigravity adapter.

## Verification

```bash
npm run check
npm test
npm --prefix web run build
```

Manual: start the API and Vite UI, import to live Pi, quit the running `pi`
session and reopen. `/reload` does not reread `models.json` or `enabledModels`.
