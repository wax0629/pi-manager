# Pi Manager

Pi 的本地控制面。不 fork Pi，不改项目 `.pi`。在页面里管供应商、模型和 Thinking，确认后备份并写入 `~/.pi/agent`，给普通 `pi` 命令用。

## 能做什么

- **供应商与账号**：新增 OpenAI 兼容中转、从本机 Pi 勾选导入、Pi 原生登录。新增时可请求上游 `/models`，勾选后再保存。
- **模型资源库**：完整目录、Ctrl+P 循环列表、默认模型、Thinking 映射、Context 窗口。
- **导入本机 Pi**：备份后合并写入 `~/.pi/agent` 的 `settings.json` / `models.json` / `auth.json`，可回滚。

日常路径：改候选配置 → **导入本机 Pi** → 退出当前 Pi 再进。`/reload` 不会重读模型和循环列表。

## 不做什么

- 不 fork、不改 Pi 源码。
- 不改用户项目里的 `.pi`。
- 不把 refresh token 拷进 Manager。
- 不做 Antigravity 专用 OAuth；Antigravity 当本机 OpenAI 兼容桥（`127.0.0.1:8045/v1`）。

## 要求

- Node 20+
- 已安装官方 [Pi](https://github.com/badlogic/pi-mono)（`pi` 在 PATH 里）

## 运行

```bash
npm start          # API  http://127.0.0.1:8670
npm run dev:web    # UI   http://localhost:5173/
```

生产构建后只开 API 即可，静态页从 `web/dist` 提供：

```bash
npm --prefix web run build
npm start
```

## 日常用法

1. 打开供应商页：新增 API，或从本机 Pi 勾选导入，或登录原生渠道。
2. 打开模型资源库：核对目录、默认模型、循环列表、Thinking。
3. 打开「导入本机 Pi」，确认后写入 `~/.pi/agent`。
4. 退出正在跑的 Pi，重新打开。用 `pi --list-models --offline` 核对。

导坏了用同一页的 **回滚本机 Pi**。

## 数据放哪

| 路径 | 用途 |
| --- | --- |
| `~/.pi-manager/` | Manager 状态、密钥存储、导入备份 |
| `~/.pi/agent/` | 本机 Pi 真正读取的配置 |

密钥不进 `state.json`，也不在 API 响应里回显。

## 开发

```bash
npm test
npm run check
npm --prefix web run lint
npm --prefix web run build
```

设计草案仍在 `docs/`，以本 README 和当前 UI 为准。隔离 Profile 的 apply / launch / stop 后端还在，页面已拿掉，不是日常路径。

## License

尚未选定。
