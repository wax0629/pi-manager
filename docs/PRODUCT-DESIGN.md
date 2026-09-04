# Pi Manager 产品与架构设计草案

- 状态：Proposal / FullSpec 草案
- 阶段：设计阶段，尚未进入功能开发
- 工作名称：Pi Manager
- 设计目标：用独立的本地 UI 管理 Pi 的供应商、凭据、模型与启动 profile

## 1. 产品定位

Pi Manager 是 Pi 的本地运行控制面。它不替换 Pi 的 agent 核心，不 fork
Pi，也不把用户项目的 `.pi` 配置作为主要数据源，而是维护自己的 profile，
在启动 Pi 时通过官方配置目录、认证文件、模型文件、扩展点和 CLI 参数注入
配置。

一句话价值：用户不需要手工编辑 `auth.json`、`models.json`、
`settings.json` 或记住供应商参数，就能用页面切换 Pi 的账号、模型、循环列表
和 thinking 映射。

## 2. 动机与用户故事

### 真实场景

1. 用户有 ChatGPT/Claude/GitHub Copilot 等 Pi 原生订阅，希望通过 Pi 原生
   `/login` 登录，而不是由第三方软件重新实现 OAuth。
2. 用户也有七牛、公司网关或其他 OpenAI-compatible 中转，希望输入 URL 和
   API key 后把它们加入 Pi。
3. Pi 的有效模型较多，用户只想在 Ctrl+P 循环中保留少量模型，并为不同模型
   设置正确的 thinking 等级映射。
4. 用户切换项目或供应商时，不希望手工复制配置，也不希望意外污染项目原有的
   `.pi` 配置。

### 共同需求

用一个可视化、本地、安全、可回滚的入口管理 Pi 的“凭据 + 供应商 + 模型 +
启动方式”。

## 3. 目标用户

- 已安装 Pi、但不想长期手工维护 JSON 配置的开发者；
- 同时使用官方订阅和多个 API/中转的个人用户；
- 需要快速验证不同模型与 thinking 参数的高级用户。

## 4. 现状及不足

Pi 本身已经提供 OAuth/API key 认证、`auth.json`、`models.json`、
`settings.json`、`--models`、`--provider`、`--model`、RPC 和 SDK。问题不在
于 Pi 缺少运行能力，而在于这些能力分散在终端命令、环境变量和多个 JSON 文件
中。

cockpit-tools 提供了值得借鉴的控制面模式：React/Tauri UI 负责状态和账号，
Rust 负责受控文件与进程，sidecar 负责统一网关，manifest 负责路由，profile
接管前先备份、停用后恢复。Pi Manager 借鉴这些边界和生命周期管理，但首版优先
使用 Pi 自己已有的 provider/config API；只有非标准渠道才引入本地 Gateway。

## 5. 本期范围

### 做

- 检测 Pi 可执行文件、版本和文档能力；
- 发现并展示 Pi 原生 provider 及其支持的认证方式；
- 从 UI 启动 Pi 原生 `/login` 流程，并展示已登录/未登录/过期状态；
- 管理 Pi 原生 API key provider；
- 添加 OpenAI-compatible 第三方中转：名称、URL、API key、协议、模型；
- 展示 effective model catalog，包含 provider、model ID、能力和 thinking；
- 编辑默认 provider/model、Ctrl+P 循环列表和模型 thinkingLevelMap；
- 为每个项目生成独立 Pi profile；
- 一键应用、启动、停止、回滚和诊断；
- 记录配置变更摘要与运行错误，但不记录 prompt、完整 token 或密钥。

### 明确不做

- Antigravity 等特殊订阅/非标准 OAuth；
- 伪造或重新实现官方订阅认证；
- 修改 Pi 核心源码或要求用户 fork Pi；
- 首版账号池、配额轮换、复杂 fallback/retry；
- 云端同步、远程管理、多用户服务端；
- 对所有 Pi 原生 provider 无条件承诺“删除完整列表中的模型”。该能力必须
  通过 provider 级验证；Pi 当前公开配置对 `enabledModels` 和完整目录的
  语义不同，详见第 9 节。

## 6. 关键决策

### 6.1 不 fork Pi，使用独立 profile

备选方案：

1. fork Pi，修改核心配置和 provider 注册逻辑；
2. 修改用户项目 `.pi`；
3. 维护 Pi Manager profile，并在启动时注入。

选择 3。Pi 已提供 `PI_CODING_AGENT_DIR`、`auth.json`、`models.json`、
`settings.json`、扩展注册、SDK/RPC 和 CLI 入口。独立 profile 更容易回滚，
也不会和项目自己的扩展、设置、升级产生不可见耦合。

### 6.2 原生渠道走 Pi，非标准渠道再走 Gateway

原生订阅和 API provider 的认证、刷新、流式协议由 Pi 处理。Pi Manager 只
负责触发登录、保存 profile、读取状态。

标准 OpenAI-compatible 中转直接写入 Pi 的 `models.json`，不增加一层代理。
以后遇到 Antigravity 这类需要协议转换、账号轮换或特殊刷新逻辑的渠道，再由
`Provider Adapter` 接入可选的本地 Gateway。这样首版不把所有请求都强制绕过 Pi。

### 6.3 凭据与配置分离

UI 状态只保存 provider、模型和凭据引用。API key 优先保存到 macOS Keychain，
运行时按 profile 生成 Pi 可读取的认证配置。OAuth 由 Pi 原生 `/login` 写入
对应 profile 的 `auth.json`，Manager 不复制 refresh token，也不实现第二套刷新器。

### 6.4 用完整引用标识模型

模型引用始终使用：

```text
<providerId>/<modelId>
```

例如：

```text
openai-codex/gpt-5.6-luna
qiniu/gpt-5.6-luna
my-company/gpt-5.6-luna
```

同名模型来自不同渠道时不能靠模型名猜路由。`providerId` 是路由和凭据查找的
唯一来源。

## 7. 信息架构与页面

### 总览

- 当前项目和 Pi 可执行文件；
- 当前 profile、provider、model、thinking；
- 原生账号状态；
- 自定义渠道状态；
- 未应用变更、配置指纹、最近错误；
- `应用并启动 Pi`、`仅应用`、`回滚`。

### 供应商与账号

- Pi 原生订阅：provider、登录状态、登录/退出/重新授权；
- Pi 原生 API：provider、API key 状态、登录流程入口；
- 自定义中转：URL、协议、API key、连通性检查、模型列表；
- 密钥只显示“已配置/未配置/过期”，不回显原文。

### 模型管理

- effective catalog 表格：来源、provider、model ID、显示名、输入能力、
  上下文、最大输出、reasoning、thinking 等级；
- 循环列表开关；
- 完整目录可见性策略；
- thinking 映射编辑器：Pi 的 `off/minimal/low/medium/high/xhigh/max`
  对应上游值，允许 `null` 表示不支持；
- 保存前显示“将写入哪些 Pi 文件、哪些模型只会影响 Manager 视图”。

### 路由与 Profile

- 项目路径；
- profile 列表；
- 默认 provider/model/thinking；
- 当前配置和上次已应用配置的差异；
- 启动 Pi、停止 Pi、恢复用户原配置。

### 诊断

- Pi 版本和能力检测；
- auth 检查；
- effective catalog 检查；
- provider 连通性和最近错误；
- 端口冲突（仅 Gateway 使用时）；
- 配置注入报告。

## 8. 领域模型

```ts
type AuthMode = "oauth" | "api_key";
type ProviderSource = "pi-native" | "custom" | "adapter";
type ApiKind =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ProviderAccount {
  id: string;
  displayName: string;
  source: ProviderSource;
  piProviderId: string;
  authModes: AuthMode[];
  api?: { baseUrl: string; kind: ApiKind; headers?: Record<string, string> };
  credentialRef?: string;
}

interface ModelDefinition {
  providerId: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
}

interface ModelPolicy {
  ref: { providerId: string; modelId: string };
  visibleInFullCatalog: boolean;
  enabledForCycling: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

interface PiProfile {
  id: string;
  targetProject: string;
  defaultModel: { providerId: string; modelId: string; thinking?: ThinkingLevel };
  modelPolicies: ModelPolicy[];
  providerAccounts: ProviderAccount[];
  configRevision: number;
}
```

## 9. 循环列表与完整列表

### 循环列表

这是 Pi 原生的 `settings.json.enabledModels` 或 `--models`，控制 Ctrl+P
循环范围。例如：

```json
{
  "enabledModels": [
    "qiniu/gpt-5.6-luna",
    "qiniu/gpt-5.6-sol",
    "qiniu/grok-4.6"
  ]
}
```

UI 的“加入循环列表”直接映射为 `enabledForCycling`，保存后可验证 Pi 的
`/scoped-models` 和 Ctrl+P 范围。

### 完整列表

完整列表不是另一个叫 `fullModels` 的 JSON 数组。Pi 的有效目录来自：

- 内置 provider catalog；
- profile 的 `models.json`；
- extension 注册 provider/model；
- 远程刷新结果和 `models-store.json` 缓存；
- 当前凭据导致的 provider 可用性过滤。

因此 Manager 采用两层模型：

1. `effectiveCatalog`：通过 Pi SDK/Runtime 读取的真实有效目录；
2. `ModelPolicy`：Manager 维护的“显示、循环、thinking 覆盖”策略。

对于自定义 provider，可以用 `models.json` 中的 `models` 精确生成目录。
对于原生 provider，`modelOverrides` 可以修改名称、reasoning、能力、成本、
上下文、最大输出和 `thinkingLevelMap`，但不会通用删除内置模型。

### 完整列表隐藏的验收边界

首版必须先为每个目标 Pi provider 做 capability test：

- 若 Pi 当前扩展/Runtime 能对该 provider 施加过滤，则 Apply 后必须验证 `/model`
  和 effective catalog 都只出现保留项；
- 若只能修改 metadata，UI 必须明确显示“该 provider 的 Pi 原生模型仍可见”，
  不得假装已经删除；
- 不能为了隐藏模型而重写官方 OAuth/stream provider；
- 若这是产品必须能力，应向 Pi 上游提出稳定的 provider/catalog filter API，
  Manager 以 adapter 方式接入，而不是 fork 核心。

这条边界是设计中的最大技术风险，也是进入开发前必须做的 spike。

## 10. 系统架构

```text
Pi Manager Desktop
  ├─ UI / View Model
  ├─ Profile Manager
  ├─ Credential Manager
  ├─ Pi Adapter
  │    ├─ install/version discovery
  │    ├─ native login launcher
  │    ├─ ModelRuntime/SDK catalog reader
  │    └─ RPC/session inspector
  ├─ Catalog & Policy Manager
  ├─ Provider Adapter Registry
  ├─ Process Manager
  ├─ Optional Local Gateway
  └─ Diagnostics / Audit Log

Pi process
  └─ isolated PI_CODING_AGENT_DIR profile
       ├─ native subscription/API auth
       ├─ custom models.json provider
       ├─ enabledModels/default model settings
       └─ optional Manager extension
```

正式桌面产品建议使用 Tauri + React + TypeScript + Rust：UI 负责操作和状态，
Rust 负责 Keychain、原子写文件、子进程、PTY 和权限；Pi 的 SDK/CLI 作为外部
运行时。早期也可以用 Node 做 Adapter spike，但不把 Node 服务端当最终桌面边界。

## 11. 配置注入方案

### 11.1 Manager 自己的数据目录

```text
~/.pi-manager/
  state.json                         # 非敏感 UI 状态、profile 元数据
  profiles/
    <profile-id>/
      settings.json                  # Pi settings
      models.json                    # 自定义 provider、override、模型元数据
      auth.json                      # Pi 原生 OAuth/API auth，权限 0600
      sessions/                      # 可选：profile 专属会话
      extensions/
        pi-manager-catalog.ts        # 仅在需要 provider adapter 时生成
      manifest.json                   # Manager 自己的来源和 revision
      launch.command                 # 可选的可审计启动入口
  runtime/                           # 临时环境、日志、Gateway 状态
```

真实实现中，应用数据根目录应使用系统 app-data 路径；上面的路径是概念结构。
密钥优先放系统 Keychain。若 Pi 必须读取文件中的 credential，则由 Rust 在受控
profile 下生成 `auth.json`，设置 `0600`，并避免把内容写入日志、错误栈或 UI。

### 11.2 原生 `/login` 注入

1. 用户在“供应商与账号”页面选择 Pi 原生 provider 和认证方式。
2. Manager 创建/选择目标 profile。
3. Manager 启动绑定该 profile 的 Pi 受控 PTY，执行原生 `/login <provider>`。
4. 浏览器授权或 API key 输入由 Pi 自己完成。
5. Pi 把 credential 写入该 profile 的 `auth.json`；OAuth refresh 也由 Pi 管理。
6. Manager 重新读取 auth 状态和 effective catalog，更新 UI。
7. Manager 不把官方订阅转换成普通 API key，不复制 refresh token。

### 11.3 自定义第三方中转注入

用户填写：

- provider display name 和稳定 `providerId`；
- base URL，例如 `https://llmapi.qiniu.io/v1`；
- API kind，首版默认为 `openai-completions`；
- API key；
- 模型 ID 和必要的 metadata；
- thinking 映射与 compatibility flags。

Manager 将 provider 生成到 profile 的 `models.json`，示意如下：

```json
{
  "providers": {
    "qiniu": {
      "baseUrl": "https://llmapi.qiniu.io/v1",
      "api": "openai-completions",
      "apiKey": "$PI_MANAGER_QINIU_API_KEY",
      "models": [
        {
          "id": "gpt-5.6-luna",
          "name": "GPT-5.6 Luna",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": "low",
            "low": "medium",
            "medium": "high",
            "high": "high",
            "xhigh": null,
            "max": null
          },
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 32000,
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true
          }
        }
      ]
    }
  }
}
```

上面的思考值只是格式示例，不是对七牛或某个模型能力的预设。UI 必须区分
“供应商文档确认”“请求探测确认”和“用户手工设置”，不能静默把 `max` 当成
`high`。

密钥有两个可选实现：

- 推荐：Keychain 保存原文，启动 Pi 时将值放入 profile 进程的环境变量，
  `models.json` 只保存 `$PI_MANAGER_*` 引用；
- 兼容：生成 profile 级 `auth.json` API-key credential，文件 `0600`，停止
  进程后按策略清理临时副本。

### 11.4 默认模型与启动参数

Profile 的 `settings.json` 保存稳定默认值：

```json
{
  "defaultProvider": "qiniu",
  "defaultModel": "gpt-5.6-luna",
  "enabledModels": [
    "qiniu/gpt-5.6-luna",
    "qiniu/gpt-5.6-sol",
    "qiniu/grok-4.6"
  ]
}
```

一次启动的临时选择由 CLI 参数覆盖：

```bash
PI_CODING_AGENT_DIR="$PROFILE_DIR" \
PI_CODING_AGENT_SESSION_DIR="$PROFILE_DIR/sessions" \
pi --provider qiniu \
   --model gpt-5.6-luna \
   --thinking high \
   --models "qiniu/gpt-5.6-luna,qiniu/gpt-5.6-sol,qiniu/grok-4.6"
```

实际启动器必须通过 Pi 版本探测确认参数和优先级；不要仅依赖生成 shell 脚本
作为唯一契约。Manager 应在启动前记录 resolved configuration，启动后再通过
SDK/RPC 读取一次 active model、thinking 和 scoped models 做闭环校验。

### 11.5 项目配置隔离

Manager 不写目标项目的 `.pi/settings.json`、`.pi/extensions/` 或项目 auth。
启动 Pi 时使用独立 `PI_CODING_AGENT_DIR`，并按 Pi 支持的 `--no-extensions`、
显式 extension 参数和工作目录策略控制项目扩展是否参与。由于 Pi 的 project
resources 可能从当前工作目录加载，正式实现前必须做一个隔离测试矩阵，确认：

- 用户项目 settings 是否会覆盖 profile settings；
- 项目 extension 是否会混入 Manager extension；
- `--no-extensions` 与显式 `-e` 的实际优先级；
- 如何保留项目代码工作目录，同时隔离 Manager 的运行配置。

## 12. 配置应用生命周期

```text
用户编辑 UI
  -> Manager state 校验
  -> 生成候选 profile 临时目录
  -> 解析 provider/model/auth 引用
  -> Pi dry-run / catalog validation
  -> 原子替换 profile 文件
  -> 启动或重启 Pi / optional Gateway
  -> RPC/SDK 读取实际状态
  -> 成功：提交 revision
  -> 失败：恢复上一 revision，展示具体错误
```

每次写入都应：

- 写到同目录临时文件后 rename；
- 记录 revision 和配置 fingerprint；
- 只在 fingerprint 变化且进程需要时重启；
- 在覆盖已有 Manager profile 前保留最近一个可恢复版本；
- 不直接覆盖用户原始 `~/.pi/agent`，除非用户明确选择“接管原 profile”，且
  接管前完成备份。

## 13. 可选 Local Gateway 与未来 Adapter

首版的标准 API provider 不需要 Gateway。未来的 Adapter 接口可以是：

```ts
interface ProviderAdapter {
  kind: string;
  validate(input: unknown): Promise<ValidationResult>;
  discoverModels(input: unknown): Promise<ModelDefinition[]>;
  prepare(profile: PiProfile): Promise<PreparedProvider>;
  start?(prepared: PreparedProvider): Promise<RuntimeHandle>;
  stop?(handle: RuntimeHandle): Promise<void>;
}
```

Antigravity 等非标准渠道可以由 adapter 负责本地 bridge、账号状态和协议转换；
Pi 只看到一个稳定的 Manager provider 或 localhost API。Gateway 默认只监听
`127.0.0.1`，拥有独立 client key，日志脱敏，且不应影响原生 provider 的认证
和会话状态。

## 14. 安全与恢复

- 凭据：Keychain 优先；`auth.json` 仅限 profile，权限 `0600`；
- UI：API key 只显示状态和末尾少量掩码；
- 日志：禁止 prompt、Authorization、完整 URL query 和 token；
- 网络：第三方 URL 在保存前校验 scheme，默认只允许 HTTPS；本地地址需要用户
  明确确认；
- Gateway：默认 loopback，不能无认证监听 LAN；
- 文件：所有生成文件有 manifest、revision、来源和时间戳；
- 回滚：应用失败恢复上一份 Manager profile；接管用户 profile 前保存备份；
- 删除：删除账号前先确认影响的模型和 profile，不能静默删除 credential。

## 15. 主要风险与 Spike

1. 原生 provider 的完整目录过滤：验证 `filterModels`、extension 注册和
   `modelOverrides` 的实际边界，确认是否能不破坏 OAuth/stream。
2. 项目配置与独立 profile 的加载优先级：做最小矩阵，不能凭启动命令推断。
3. OAuth PTY 生命周期：浏览器回调、取消、过期和多次登录的状态同步。
4. 各中转对 thinking 的真实语义：用供应商文档 + 真实请求验证，未验证映射
   必须标记为 tentative。
5. `models.json` 与缓存目录的刷新：配置变更后 catalog 是否即时生效，何时需要
   重启 Pi。
6. Pi 版本变化：启动参数、SDK 类型和 provider catalog 都需要 capability
   detection，不能只按版本号硬编码。

## 16. 验收标准

### MVP 必须通过

- 不 fork Pi，不修改 Pi 核心；
- 用户可在 Manager 中对至少一个 Pi 原生 OAuth provider 完成登录，并在
  profile 中恢复登录状态；
- 用户可添加一个 OpenAI-compatible URL + API key provider，配置至少一个
  model，并让 Pi 成功发送真实请求；
- 用户可设置默认 provider/model/thinking，启动后通过 RPC/SDK 校验一致；
- 用户可编辑 `enabledModels`，Ctrl+P/`/scoped-models` 与 UI 一致；
- 每个 model 的 `thinkingLevelMap` 会写入正确的 Pi model/provider 配置，
  unsupported level 使用 `null` 并在 UI 隐藏或跳过；
- 应用失败可回滚，用户原有项目 `.pi` 未被修改；
- API key、OAuth token 和 prompt 不出现在 UI 日志和普通应用日志中。

### 完整列表能力的单独门禁

- 自定义 provider：UI 的保留模型集合与 Pi effective catalog 一致；
- Pi 原生 provider：只有经过实际 capability test 的 provider 才显示“支持
  完整列表过滤”；不支持者必须明示限制；
- 若产品必须覆盖所有原生 provider，则先完成 Pi 上游 filter API 的 Proposal
  或通过稳定 extension API 验证，再进入正式实现。

## 17. Milestone 建议

### MS0：决策与调研

- 固化本 Proposal；
- 完成 Pi provider/catalog/profile 隔离 Spike；
- 为完整列表过滤建立 provider capability 表。

### MS1：架构主干

- Tauri/React/Rust 空骨架；
- UI、Pi Adapter、Credential Manager、Profile Manager 的真实接口；
- mock state 串联总览、供应商、模型和应用流程。

### MS2：核心路径

- 一个原生 OAuth provider；
- 一个自定义 OpenAI-compatible provider；
- profile 注入、真实 Pi 启动和真实请求；
- 默认模型、循环列表、thinking 映射闭环。

### MS3：MVP 闭合

- 多个原生 provider；
- 自定义 provider 编辑、诊断、回滚；
- effective catalog 与 capability gate；
- 真实用户试用和测试补齐。

### MS4：交付

- 稳定升级/迁移；
- 安全审查、安装包、用户文档、已知限制；
- Antigravity adapter 只在前述 MVP 稳定后作为下一轮 Proposal。

## 18. 结论

Pi Manager 的核心不是重写 Pi，而是把 Pi 已有的认证、模型和启动接口包装成
一个可审计、可回滚的本地控制面：

```text
UI
  -> Profile / Credential / Catalog state
  -> Pi Adapter 生成 profile
  -> PI_CODING_AGENT_DIR + settings/models/auth + CLI
  -> 官方 Pi 进程
  -> 原生 provider 或未来的可选 Adapter/Gateway
```

这样可以先把官方订阅、官方 API 和用户自定义中转统一到一个产品中，同时给
Antigravity 等特殊渠道保留扩展边界；是否需要 fork Pi 的答案仍然是否定的。
