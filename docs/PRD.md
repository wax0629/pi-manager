# Pi Manager 产品需求文档

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 产品名称 | Pi Manager |
| 文档类型 | PRD / FullSpec |
| 当前版本 | v0.1 Draft |
| 文档状态 | 待评审 |
| 产品阶段 | MS0：产品与架构设计 |
| 目标平台 | macOS 优先，后续考虑 Windows/Linux |
| 关联文档 | [产品与架构设计草案](PRODUCT-DESIGN.md) |

本文档定义 Pi Manager 首个可交付版本的用户需求和行为边界。它不替代
`PRODUCT-DESIGN.md` 中的系统架构和技术风险说明。

## 2. 产品概述

Pi Manager 是一个独立运行的本地桌面工具，让用户通过真实 UI 管理 Pi coding
agent 的供应商、账号、模型、thinking 等级和启动 profile。

用户可以在一个页面中完成：

- 使用 Pi 原生 `/login` 登录订阅或 API provider；
- 添加自己的第三方 OpenAI-compatible 中转；
- 查看所有当前可用模型及其来源；
- 编辑 Ctrl+P 循环列表、默认模型和 thinking 映射；
- 将配置应用到一个隔离的 Pi profile，然后启动 Pi；
- 在出错时查看诊断并回滚上一次配置。

Pi Manager 不重写 Pi 的 agent 核心，不伪造官方订阅认证，也不要求用户 fork
Pi。产品通过 Pi 官方提供的配置、SDK、RPC、扩展和 CLI 入口工作。

## 3. 用户问题

### 3.1 当前问题

Pi 的能力分散在多个入口：

- `/login`、环境变量和 `auth.json` 管理认证；
- `models.json` 管理第三方 provider 和模型；
- `settings.json` 或 `--models` 管理 Ctrl+P 循环列表；
- CLI 参数管理启动时的 provider、model、thinking；
- 不同 provider 的模型元数据和 thinking 语义需要用户自行维护。

用户因此需要记忆文件位置、JSON 格式、模型完整引用和认证差异。配置错误时，
还可能污染项目 `.pi` 目录或覆盖已有凭据。

### 3.2 产品机会

Pi 已经具备足够的底层能力，缺少的是一个围绕“账号、模型、路由和 profile”
组织起来的本地控制面。Pi Manager 的价值是降低配置成本，同时保持 Pi 原生
行为、透明的来源信息和可恢复性。

## 4. 目标与非目标

### 4.1 产品目标

首个版本需要达到以下结果：

1. 用户可以不手工编辑 JSON 文件，完成 Pi 原生 provider 登录或 API key 配置。
2. 用户可以添加一个第三方 URL + API key 中转，并在 Pi 中使用其模型。
3. 用户可以在一个统一视图中管理不同 provider 的同名模型。
4. 用户可以独立控制完整模型目录的显示策略和 Ctrl+P 循环范围。
5. 用户可以为每个模型设置可靠、可解释的 thinking 等级映射。
6. 用户可以把配置应用到独立 profile，并确认 Pi 实际加载的结果。
7. 任何应用失败都不会破坏用户项目原有配置，并可以回滚。

### 4.2 非目标

首个版本不包含：

- Antigravity 等需要特殊协议或非标准 OAuth 的 provider；
- 官方订阅凭据的重新实现、复制、代理或伪造；
- 多账号配额池、自动轮换、复杂重试和跨 provider fallback；
- 云端账号同步、多用户权限和远程控制；
- 修改 Pi 源码、维护 Pi fork 或替代 Pi 的 agent runtime；
- 通过名称猜测 provider，或让同名模型在不同来源之间静默切换；
- 承诺所有 Pi 原生 provider 都支持删除完整目录中的任意模型。

## 5. 目标用户与使用场景

### 5.1 目标用户

**个人开发者**

已经在使用 Pi，希望同时使用官方订阅和多个 API/中转，不想手工维护配置文件。

**模型体验用户**

经常比较不同模型，需要调整默认模型、循环列表和 thinking 等级。

**高级 Pi 用户**

理解 provider、API 协议和模型参数，希望在不修改 Pi 核心的前提下管理复杂配置。

### 5.2 核心用户故事

#### US-01：连接官方订阅

作为 Pi 用户，我希望从 Manager 进入 Pi 原生登录流程，登录 ChatGPT/Claude 等
订阅，这样我不需要把订阅转换成 API key，也不需要手工处理 OAuth 文件。

#### US-02：添加第三方中转

作为同时拥有第三方 API 的用户，我希望填写名称、URL、API key 和模型信息，就能
在 Pi 中使用该渠道。

#### US-03：管理模型来源

作为使用多个 provider 的用户，我希望看到完整的 `provider/model` 标识，这样同名
模型不会被误认为是同一个模型。

#### US-04：管理循环列表

作为高频切换模型的用户，我希望只保留自己常用的模型在 Ctrl+P 循环列表中，减少
无关模型带来的干扰。

#### US-05：管理 thinking 映射

作为使用不同模型的用户，我希望知道 Pi 的 `high`、`max` 等等级实际会发送什么
上游值，并能禁用模型不支持的等级。

#### US-06：安全应用与回滚

作为已有项目配置的用户，我希望 Manager 使用独立 profile，应用失败时可以恢复
上一版本，不影响项目原有 `.pi` 文件。

## 6. 产品原则

1. **原生优先**：Pi 原生支持的认证和 provider 由 Pi 自己处理。
2. **来源明确**：模型必须显示 provider 来源，禁止隐式路由。
3. **配置可解释**：用户能看到将要写入的文件和实际生效的结果。
4. **默认隔离**：Manager 不修改用户项目目录和默认 Pi profile。
5. **失败可恢复**：配置采用候选版本、原子替换和可回滚 revision。
6. **能力诚实**：Pi 不支持的完整目录过滤或 thinking 等级必须明确标注。
7. **本地安全**：凭据尽量进入系统 Keychain，日志不包含密钥和 prompt。

## 7. 产品范围与优先级

优先级定义：

- `P0`：MVP 必须完成；
- `P1`：首版建议完成，缺失时不阻断核心路径；
- `P2`：后续版本。

| 能力 | 优先级 | 说明 |
| --- | --- | --- |
| Pi 安装与版本检测 | P0 | 启动前必须知道使用的是哪个 Pi |
| Pi 原生 provider 发现 | P0 | 以当前 Pi 版本能力为准 |
| Pi 原生 `/login` 向导 | P0 | OAuth/API key 都通过 Pi 原生流程 |
| 自定义 OpenAI-compatible provider | P0 | URL + API key + 模型 |
| 统一 effective model catalog | P0 | 展示真实可用模型和来源 |
| 默认 provider/model/thinking | P0 | 应用并校验 |
| Ctrl+P 循环列表 | P0 | 对应 `enabledModels`/`--models` |
| thinkingLevelMap 编辑 | P0 | 支持 `null` 表示不支持 |
| 自定义 provider 完整目录管理 | P0 | 自定义目录可精确生成 |
| 原生 provider 完整目录过滤 | P1 | 逐 provider 经过 capability gate |
| profile 应用、启动、停止 | P0 | 使用独立 Pi profile |
| 应用失败回滚 | P0 | 不污染用户项目 |
| API 连通性测试 | P1 | 保存前验证配置 |
| 最近请求摘要和运行日志 | P1 | 脱敏、摘要化 |
| Local Gateway | P1 | 只为需要协议转换的 provider 启用 |
| Antigravity adapter | P2 | 单独 Proposal |

## 8. 信息架构

产品主导航包括五个区域：

1. **总览**：当前状态、未应用变更和主要操作；
2. **供应商与账号**：原生 provider、订阅/API key 和自定义中转；
3. **模型管理**：完整目录、循环列表、默认模型和 thinking 映射；
4. **Profile 与应用**：目标项目、profile、差异、应用、启动和回滚；
5. **诊断**：Pi 检测、认证、目录、生效配置和错误信息。

所有页面使用同一个 profile 上下文。用户在页面上修改的数据先进入候选状态，
明确点击“应用”后才写入运行 profile。

## 9. 功能需求

### FR-01：首次启动与环境检测

**需求**

- Manager 启动后检测 Pi 可执行文件；
- 展示 Pi 版本、可执行路径和是否可运行；
- 检测 `PI_CODING_AGENT_DIR`、`auth.json`、`models.json`、`settings.json`、
  SDK/RPC 和 extension 能力；
- 检测当前工作目录是否存在项目 `.pi` 配置；
- 检测结果必须标注“支持”“不支持”或“未验证”，不能把未知当作支持。

**验收**

- Pi 未安装时，页面显示安装路径和错误原因，不能生成看似可用的 profile；
- Pi 可用时，页面显示版本和可执行路径；
- Pi 版本变化后，Manager 重新执行能力检测，不只依赖固定版本号。

### FR-02：Pi 原生 provider 与认证

**需求**

- 展示当前 Pi 版本的原生 provider；
- 对每个 provider 展示支持的认证方式：订阅 OAuth、API key 或两者；
- 初始版本应覆盖 Pi 原生 `/login` 可发现的主要 provider，包括 ChatGPT
  Plus/Pro Codex、Claude Pro/Max、GitHub Copilot、xAI、OpenRouter OAuth、
  Radius 等；实际列表以运行时发现结果为准；
- 提供“登录”“重新授权”“退出”和“检查状态”操作；
- 登录流程必须调用 Pi 原生 `/login` 或等效官方 SDK 能力；
- OAuth refresh token 不得被 Manager 复制或自行刷新。

**登录交互**

1. 用户点击“登录”；
2. Manager 选择或创建目标 profile；
3. Manager 启动绑定该 profile 的 Pi 受控 PTY，执行原生 `/login <provider>`；
4. 用户在 Pi 流程中完成浏览器授权或 API key 输入；
5. Manager 监测登录结果，重新读取 profile 的 auth 状态；
6. 页面显示已登录、未登录、已过期或需要重新授权。

**边界**

- 浏览器授权被取消时，不能显示登录成功；
- `auth.json` 损坏时，页面必须给出修复或重新登录入口；
- Manager 不读取并展示完整 OAuth token；
- 原生 provider 不支持某种认证方式时，该按钮不可用并显示原因。

### FR-03：自定义第三方中转

**需求**

用户可以添加、编辑、禁用和删除自定义 provider，至少包含：

- 显示名称；
- 稳定 `providerId`；
- base URL；
- API 类型；
- API key；
- 自定义 headers（可选）；
- 模型列表及模型元数据。

首版 API 类型支持：

- `openai-completions`；
- `openai-responses`；
- `anthropic-messages`；
- `google-generative-ai`。

**表单规则**

- URL 必须包含合法 scheme；默认要求 HTTPS；
- `http://127.0.0.1`、`http://localhost` 等本地地址需要用户明确确认；
- providerId 只能包含稳定、可作为 Pi provider 名称的字符；
- API key 为空时允许保存模型草稿，但 provider 必须标记为不可用；
- 保存前提供“测试连接”时，不能把 key 放入诊断日志；
- 删除 provider 前显示受影响的模型、默认值和循环列表项。

**模型录入**

每个自定义模型至少支持：

- model ID；
- 显示名称；
- 是否支持 reasoning；
- 输入类型：文本、图片；
- context window；
- max output tokens；
- thinkingLevelMap；
- compatibility flags。

### FR-04：统一模型目录

**需求**

- 统一展示 Pi 当前 effective model catalog；
- 每一行必须展示 `providerId/modelId`；
- 展示来源类型：Pi 原生、自定义、未来 adapter；
- 展示认证可用性：可用、未认证、认证过期、配置错误；
- 展示模型能力：输入类型、reasoning、context、max tokens、thinking 等级；
- 支持按 provider、模型名、来源和可用性筛选；
- 对同名不同 provider 的模型分开显示。

**目录来源**

Manager 需要把以下来源合并成用户可理解的 effective catalog：

- Pi 内置 provider catalog；
- profile `models.json`；
- extension 注册 provider/model；
- 远程刷新结果及 Pi 缓存；
- 凭据导致的可用性过滤。

**目录状态**

- `discovered`：已被 Pi 发现；
- `available`：有可用认证且可选择；
- `unavailable`：目录存在但缺少认证或配置；
- `hidden`：被 Manager 策略隐藏；
- `invalid`：元数据或 provider 配置不合法。

### FR-05：完整列表管理

**需求**

用户可以在模型管理页面为模型设置“在完整目录中显示/隐藏”。但该操作的实际
效果必须由 provider 能力决定：

| provider 类型 | 首版行为 |
| --- | --- |
| 自定义 provider | 由 Manager 生成模型数组，支持精确保留 |
| 支持过滤的原生 provider | Apply 后验证 effective catalog，支持保留集合 |
| 仅支持 metadata override 的原生 provider | 允许保存策略，但明确提示 Pi 原生目录仍可能可见 |
| 未验证 provider | 禁止显示“过滤成功”，要求先完成 capability test |

产品不能把“Manager UI 中隐藏”误报为“Pi `/model` 已删除”。

**验收**

- 自定义 provider 只保留用户指定模型时，Pi 的 effective catalog 与 UI 一致；
- 原生 provider 只有在实际验证 `/model`、SDK/RPC 结果后，才能显示过滤成功；
- 不支持过滤时，用户仍能管理循环列表，但必须看到完整列表限制说明；
- 不得通过重写官方 OAuth 或 stream provider 来强行隐藏模型。

### FR-06：循环列表

**需求**

用户可以在统一模型目录中勾选模型加入 Ctrl+P 循环列表，并拖动排序。

Pi 映射关系：

```json
{
  "enabledModels": [
    "qiniu/gpt-5.6-luna",
    "openai-codex/gpt-5.6-luna",
    "qiniu/grok-4.6"
  ]
}
```

**规则**

- 列表项必须保存完整的 `providerId/modelId`；
- 不允许只保存裸模型 ID；
- 循环列表为空时，Pi 使用自身默认行为，UI 必须提示影响；
- 被禁用、未认证或 invalid 的模型不能应用到循环列表；
- 删除 provider 或 model 时，相关循环列表项必须被标记并要求处理；
- UI 顺序就是写入顺序，不能按名称重新排序。

**验收**

- 用户只保留三个模型后，Pi `/scoped-models` 与 UI 三项一致；
- Ctrl+P 循环顺序与 UI 顺序一致；
- 同名模型来自不同 provider 时可以同时加入；
- 运行中修改候选配置不会改变已启动 Pi，直到用户应用或重启。

### FR-07：默认模型与 thinking

**需求**

用户可以设置：

- 默认 provider；
- 默认 model；
- 默认 thinking level；
- 单个模型的 thinkingLevelMap。

Pi 标准等级为：

```text
off / minimal / low / medium / high / xhigh / max
```

每个等级允许三种状态：

- 字符串：支持，并向上游发送该值；
- `null`：不支持，在 UI 中隐藏、跳过或按 Pi 规则处理；
- 未设置：使用 provider 默认映射；`xhigh` 和 `max` 默认不视为支持。

**映射编辑器行为**

- UI 左侧显示 Pi 标准等级；
- UI 右侧显示上游实际值；
- 对 `null` 显示“不支持”；
- 区分“供应商文档确认”“请求探测确认”“用户手工设置”；
- 当模型 `reasoning=false` 时，默认只显示 `off`；
- 默认等级必须是当前模型支持的等级；
- 当用户选择不支持的默认等级时，阻止保存并说明可用等级。

**示例**

```json
{
  "thinkingLevelMap": {
    "off": "none",
    "minimal": "low",
    "low": "medium",
    "medium": "high",
    "high": "high",
    "xhigh": null,
    "max": null
  }
}
```

该示例只说明数据结构，不代表任何具体供应商的真实能力。

### FR-08：Profile 管理

**需求**

- 用户可以创建、重命名、复制和删除 Pi Manager profile；
- profile 至少绑定一个目标项目；
- profile 保存 provider、credential reference、模型策略和默认值；
- profile 之间互相隔离；
- UI 显示当前 profile 是否有未应用变更；
- profile 需要保存 revision、fingerprint 和最近应用结果。

**默认隔离规则**

- Manager 不修改目标项目的 `.pi/settings.json`；
- Manager 不修改目标项目的 `.pi/extensions/`；
- Manager 不覆盖用户默认 `~/.pi/agent`；
- 运行时通过独立 `PI_CODING_AGENT_DIR` 指向 Manager profile；
- 用户明确选择“接管已有 Pi profile”时，必须先备份且提供恢复操作。

### FR-09：应用、启动、停止与回滚

**主要操作**

- `仅保存`：保存候选状态，不改变运行进程；
- `应用`：生成 profile 并验证配置；
- `应用并启动`：应用成功后启动 Pi；
- `停止 Pi`：停止 Manager 启动的 Pi 进程；
- `回滚`：恢复上一份成功应用的 profile；
- `查看注入报告`：显示文件、参数和生效状态。

**应用流程**

```text
编辑候选状态
  -> 校验 provider/model/auth
  -> 生成临时 profile
  -> 写入 settings/models/auth/manifest
  -> Pi dry-run 或 catalog validation
  -> 原子替换正式 profile
  -> 启动/重启 Pi（如需要）
  -> RPC/SDK 读取 active model、thinking、scoped models
  -> 成功提交 revision；失败恢复上一 revision
```

**错误规则**

- 任一必要文件写入失败，不能提交半成品 profile；
- provider 无认证时，不能报告为可用；
- 默认模型不存在时，阻止应用；
- 启动后实际模型与请求不一致时，标记应用失败并提供日志位置；
- 端口冲突只影响 Gateway 或本地服务，不应误报为 Pi 原生 provider 失败。

### FR-10：诊断与状态

**页面需要展示**

- Pi 路径和版本；
- 当前 profile 路径和 revision；
- 当前生效 provider/model/thinking；
- auth 状态；
- effective catalog 状态；
- Gateway 状态（如启用）；
- 最后一次应用时间和结果；
- 最近错误、请求状态和耗时摘要。

**日志规则**

- 不记录 prompt、完整响应、API key、OAuth token、Authorization header；
- URL query 中疑似密钥的字段必须脱敏；
- 日志事件使用 request ID、providerId、modelId、状态码和错误分类；
- 用户可以导出不含凭据的诊断包。

## 10. 关键用户流程

### 10.1 添加七牛类中转并使用模型

1. 用户进入“供应商与账号”；
2. 点击“添加自定义中转”；
3. 输入名称、providerId、`https://llmapi.qiniu.io/v1`、OpenAI-compatible；
4. 输入 API key，选择保存到系统 Keychain；
5. 添加 `gpt-5.6-luna` 等模型并设置能力；
6. 点击“测试连接”；
7. 在模型管理中加入循环列表；
8. 设置默认模型和 thinking；
9. 点击“应用并启动 Pi”；
10. Manager 显示生成的 profile、实际 active model 和验证结果。

### 10.2 登录官方订阅

1. 用户选择 Pi 原生 provider；
2. 点击“登录订阅”；
3. Manager 启动 Pi 原生 `/login`；
4. 用户完成授权；
5. Manager 读取 profile auth 状态；
6. 用户从统一模型目录选择该订阅下的模型；
7. 应用 profile 并启动 Pi。

### 10.3 只调整循环列表

1. 用户进入“模型管理”；
2. 在完整目录中筛选并勾选模型；
3. 拖动调整顺序；
4. Manager 显示对应的 `enabledModels` 预览；
5. 用户点击“应用”；
6. 下一次启动或按支持情况重载后，Pi 使用新的 Ctrl+P 范围。

### 10.4 应用失败回滚

1. 用户修改 provider URL 或 thinking 映射；
2. 点击“应用并启动”；
3. Pi 校验或启动失败；
4. Manager 保留错误原因和 revision；
5. Manager 恢复上一份成功 profile；
6. 用户可以继续使用上一份配置并修复候选配置。

## 11. 配置生效要求

### 11.1 Pi 文件映射

| 产品能力 | Pi 生效入口 |
| --- | --- |
| 原生 OAuth/API key | profile `auth.json`，由 Pi `/login` 或 Pi auth runtime 管理 |
| 自定义 provider | profile `models.json` |
| 默认 provider/model | profile `settings.json` 或启动 CLI 参数 |
| Ctrl+P 循环列表 | `settings.json.enabledModels` 或 `--models` |
| 单次启动模型 | `--provider` + `--model` |
| 单次启动 thinking | `--thinking` |
| provider/model 元数据 | `models.json`、`modelOverrides` 或 extension |
| 非标准协议转换 | 可选 Local Gateway / Provider Adapter |

### 11.2 生效优先级

产品需要在 UI 中区分：

- **候选配置**：用户正在编辑，还未写入运行 profile；
- **已应用配置**：已生成并验证；
- **运行配置**：当前 Pi 进程实际读取的配置；
- **回滚配置**：最近一次成功应用的 revision。

启动时的 `--provider`、`--model`、`--thinking` 是该次运行的明确选择，
`settings.json` 是 profile 的持久默认值。Manager 启动后必须通过 Pi RPC/SDK
重新读取实际状态，不能仅凭命令生成成功就显示应用成功。

## 12. 非功能需求

### NFR-01：安全

- macOS 下 API key 默认保存到 Keychain；
- 如果必须写入 `auth.json`，文件权限为 `0600`；
- 应用数据目录默认仅当前用户可读；
- Gateway 默认只监听 `127.0.0.1`；
- UI 不显示完整密钥；
- 所有日志和错误消息经过脱敏；
- 第三方 URL 默认 HTTPS，本地 HTTP 必须显式确认。

### NFR-02：可靠性

- 配置写入采用临时文件 + 原子 rename；
- 应用失败不能留下不可解析的正式 profile；
- 最近至少保留一份成功 revision；
- Manager 异常退出后，下次启动可以恢复 profile 状态；
- 停止 Manager 不应删除用户项目文件。

### NFR-03：可理解性

- 每个模型都显示 provider 来源；
- 每次应用前显示变更摘要；
- 不支持的能力必须显示原因；
- 错误消息应包含用户可执行的下一步，而不是只显示堆栈；
- 不使用“已接入”描述代替真实认证或连通性状态。

### NFR-04：兼容性

- Pi 升级后执行 capability detection；
- 未识别的新字段不得破坏已有 profile；
- 所有新增持久化字段需要默认值和迁移策略；
- 不能依赖某一个固定 Pi 版本的内部文件路径作为唯一实现方式。

### NFR-05：性能

- 本地页面首次显示基础状态不应等待所有远程模型刷新完成；
- 远程目录刷新需要可取消，并显示加载状态；
- 常规 provider/model 编辑不应启动 Gateway；
- 配置未变化时，Apply 不应无条件重启 Pi 或 Gateway。

## 13. 验收标准

### MVP 验收场景

#### AC-01：Pi 原生认证

- 在干净 profile 中启动 Pi 原生 `/login`；
- 用户完成一个 OAuth provider 登录；
- Manager 显示已登录；
- 重启 Manager 后状态仍可恢复；
- refresh token 未出现在 Manager 日志或 UI。

#### AC-02：第三方 provider

- 添加一个 OpenAI-compatible URL + API key provider；
- 配置至少一个模型；
- 测试连接成功或显示可定位的失败原因；
- Pi 通过该 provider 完成一次真实请求；
- provider 禁用后，模型显示 unavailable，不能继续作为默认模型。

#### AC-03：统一模型目录

- 同一 model ID 在两个 provider 下显示为两条记录；
- UI、Pi effective catalog 和实际请求使用完整 provider/model 来源；
- 不存在裸模型名导致的静默切换。

#### AC-04：循环列表

- UI 保留三个模型并设置顺序；
- 写入 `enabledModels` 后，Pi `/scoped-models` 与顺序一致；
- Ctrl+P 只循环这三个模型；
- 删除其中一个模型时，UI 要求重新处理循环列表。

#### AC-05：thinking 映射

- UI 可编辑 `off` 至 `max` 的映射；
- 不支持的等级保存为 `null`；
- 不支持的等级不会出现在该模型的选择器中；
- 默认 thinking 不能设置为 `null` 等级；
- 真实请求验证发送的上游 thinking 参数符合映射。

#### AC-06：隔离与回滚

- 应用前生成独立 profile；
- 目标项目 `.pi` 文件内容不发生变化；
- 人为制造配置错误，应用失败；
- Manager 恢复上一份成功 revision；
- Pi 可以继续使用回滚后的配置。

#### AC-07：完整目录限制透明

- 自定义 provider 支持精确保留模型；
- 原生 provider 根据 capability test 显示相应能力；
- 不支持过滤时，UI 明确告诉用户“循环列表可控，但 Pi 原生完整目录仍可能可见”；
- 任何情况下不显示虚假的“已删除”状态。

## 14. 成功指标

首版试用阶段关注以下指标：

- 新用户从启动 Manager 到完成第一个可用 Pi profile 的时间；
- 不依赖手工编辑 JSON 完成配置的比例；
- provider 配置失败后能否自行定位和修复；
- 应用失败后成功回滚的比例；
- 用户配置后实际使用的循环模型数量是否下降；
- 未脱敏凭据或 prompt 进入日志的事件数，目标为零。

这些指标用于验证产品是否减少了配置负担，不作为首版上线前的硬性商业指标。

## 15. 风险与待决策事项

### R-01：原生 provider 完整目录过滤

当前 Pi 的 `enabledModels` 只控制循环列表，`modelOverrides` 主要修改模型元数据。
需要逐 provider 验证完整目录过滤能力。若 Pi 没有稳定的过滤 API，首版只能保证
“统一展示 + 循环列表控制 + 对限制诚实提示”。

### R-02：项目资源加载优先级

需要验证独立 `PI_CODING_AGENT_DIR` 与当前工作目录 `.pi` 资源的实际加载关系，
尤其是 project settings 和 project extensions 是否会影响 Manager profile。

### R-03：OAuth PTY 体验

首版可以使用受控终端承载 `/login`。正式发布前需要确认浏览器回调、取消、异常
退出和多次授权的 UI 状态。

### R-04：thinking 能力的事实来源

不同中转可能把 `high`、`xhigh`、`max` 映射成不同参数。未有供应商文档或真实
请求验证时，只能标记为 tentative，不能由 Manager 自动推断。

### R-05：是否引入 Local Gateway

标准 API 中转优先直接接入 Pi。只有出现协议转换、特殊认证、账号池或路由需要时，
才启用 Gateway；Gateway 作为独立 P1/P2 能力评审。

## 16. 版本计划

### v0.1：设计确认

- 评审本 PRD 和产品架构草案；
- 完成 Pi provider、目录、profile 隔离 capability spike；
- 固化首版支持的 Pi 版本范围。

### v0.2：主干与单渠道闭环

- Pi 检测；
- 一个原生登录 provider；
- 一个自定义 OpenAI-compatible provider；
- profile 生成和真实 Pi 启动。

### v0.3：模型管理 MVP

- effective catalog；
- 默认模型；
- 循环列表；
- thinking 映射；
- RPC/SDK 生效校验。

### v0.4：质量与恢复

- provider 编辑；
- 应用差异；
- 回滚；
- 诊断；
- 安全和异常场景测试。

### v1.0：首版交付

- MVP 功能闭合；
- 支持的 Pi 版本和 provider 清单；
- 安装包、用户文档和已知限制；
- Antigravity 等特殊渠道另立 Proposal，不与本版本混入。

## 17. 结论

Pi Manager 首版交付的是一个本地、可视化、可回滚的 Pi 配置控制面。其核心
用户价值不是替换 Pi，而是把 Pi 原生认证、第三方中转、模型目录和启动 profile
组织成一条透明的用户流程：

```text
用户 UI
  -> 候选配置
  -> 独立 Pi profile
  -> auth.json / models.json / settings.json / CLI
  -> Pi runtime
  -> provider/model 实际生效校验
```

只要 Pi 官方能力可以完成，就由 Pi 原生处理；只有标准入口无法覆盖的渠道，才
通过后续 adapter 或 Gateway 扩展。这是首版控制复杂度、保护用户凭据并保持升级
兼容性的核心取舍。
