# mg-purge

**破甲 for [magpie](https://usemagpie.ai).** dsh-purge's prompt-injection layer, ported to a magpie gateway middleware — one local gateway, every agent behind it gets the operator-priority system prompt, the boost tail block, refusal detection and thinking-tag stripping.

> 这是 [dsh-purge（破甲）](https://github.com/kingcharleslzy-ai/dsh-purge) 在 magpie 上的**提示词注入层**移植，不是 dsh-purge 的完整替代。

## 它做什么

magpie 的 middleware 只站在**网关**这一层：改写 agent 发给模型的文本、以及模型回传的文本。mg-purge 在这一层实现四件事：

| 能力 | 选项 | 作用 |
| --- | --- | --- |
| 系统提示词注入 | `preset` + `agents` / `excludeAgents` / `models` | 把选定预设注入到各 API 的系统提示词位置，可按 agent / 模型过滤 |
| 尾部强化段 | `boost` | 将 `<dsh_boost>` 段追加到最后，抵抗长上下文与多轮漂移 |
| 拒绝检测 | `refusalDetect` | 检测回复开头的短拒绝并写一行日志，**不改动回复正文**（旧键 `refusalRetry` 仍兼容，但同样只检测） |
| think 剥离 | `stripThink` | 去掉回复开头的 `<think>…</think>`，不留在历史里 |
| 上下文守卫 | `injectMaxBodyChars` | 请求文本已超过该字符数（默认 900000 ≈ 26 万 token）时**跳过注入**，避免把贴边请求顶过模型上下文上限；检测与 think 剥离照常 |

需要「改审批 / 沙箱 / agent 循环」那种改动宿主本体的能力，请用 dsh-purge 改 DSH 宿主；mg-purge 只让 **所有** magpie 下游 agent（Claude Code / Codex / DSH / …）共享同一份提示词注入。

## 安装

```sh
# 从 git 仓库直装
magpie plugin add hotker/mg-purge

# 或从自定义索引源（见下）一键装（发布到 npm 后）
magpie plugin add mg-purge
```

装好后 magpie 网关（`127.0.0.1:3425`）上流过的每个 agent 请求都会带上注入，新会话生效。配置方式（任选）：

- 打开左侧栏 **mg-purge** 看板，直接改参数（即时热加载，无需重启）；
- 或在 **Plugins › Installed › Options** 里编辑；
- 或用命令：

```sh
magpie plugin options mg-purge '{"preset":"unrestricted","boost":false,"refusalDetect":true,"stripThink":true}'
```

## 看板与面板

mg-purge 自带两个界面（`package.json` 的 `magpie.page` 与 `magpie.panels`）：

- **整页看板**（左侧栏「mg-purge」）：调用 / 错误 / 调用成功率 / 成本四张卡 + 按模型调用成功率表 + **全部参数的可视编辑**。改完即写回插件 options，网关自动热加载。
- **Usage 面板**（Usage 页底部）：一行看**全网关**调用成功率、调用数、错误数，带进度条。

统计来自 magpie 的 `usage:summary`（插件声明 `permissions: ["usage:summary"]`），口径为 `调用成功率 = 成功调用 / 总调用`，错误含 `status ≥ 400` 与 `errType` 非空。真实粒度为**总量**与**按模型**；按 agent 维度需要宿主的完整用量账本，请用 magpie 自带 Usage 页查看。

## 选项

```json
{
  "preset": "unrestricted",
  "position": "append",
  "override": true,
  "boost": false,
  "refusalDetect": true,
  "stripThink": true,
  "agents": [],
  "excludeAgents": [],
  "models": [],
  "systemPrompt": "",
  "refusalPatterns": []
}
```

- **`preset`** — `unrestricted`（默认）/ `redteam` / `coherence` / `minimal` / `off`。`coherence` 面向正常开发：让 agent 把已授权、目标明确的任务一次做完、少反复确认、被拒先换路，适合日常写代码/运维。`off` 只做 think 剥离与拒绝检测。预设文案见 [`presets/packs.json`](presets/packs.json)。
- **`position`** — `append`（默认，尽量晚、但仍落在缓存断点之前）或 `prepend`（最靠前）。Anthropic 的 `system` 是块数组且某块带 `cache_control` 时，`append` 会把注入块插在**最后一个带 `cache_control` 的块之前**——这样注入文本在缓存前缀里（后续每轮 ≈0.1x 读），又比放在最前面更靠后。
- **`cacheAlign`** — `true`（默认）。设 `false` 可以退回旧行为：`append` 时把注入块直接 push 到块数组末尾（在缓存断点之后，注入文本每轮按全价计费）。只有在你的模型/上游对块顺序有特殊要求时才关。
- **`override`** — `true`（默认）时即使 agent 已有系统提示词也注入；`false` 时仅在请求没有系统提示词时才加。
- **`boost`** — `false`（默认）。设 `true` 追加 `<dsh_boost>` 尾部强化段（约 900 字符）。
- **`refusalDetect`** — `true`（默认）。检测回复开头是否有「短、无实质内容」的推脱，命中时写一行日志 `[mg-purge] refusal opening detected`，**不修改回复正文**。判定条件：命中须在开头 120 字内、整段 < 300 字、且未附带实际内容（代码块、编号步骤、「我可以给你 / here's / 下面」等）。
  > **没有 retry。** 网关中间件无法重跑模型，也不能改一条已在流式输出的回复，所以这里只检测、只记日志。该选项因此叫 `refusalDetect`；旧名 `refusalRetry` 仍被接受为兼容别名（同样只检测），且不会刷日志——中间件沙箱里没有文件系统、每次调用又是独立隔离，「只警告一次」做不到，与其每次都刷屏不如不警告。
- **`stripThink`** — `true`（默认）。去掉回复开头的 `<think>` / `<thinking>` / `<thought>` 块，流式与整包都处理。受 `agents` / `excludeAgents` / `models` 同样约束。
- **`injectMaxBodyChars`** — `900000`（默认，约 26 万 token）。请求自身的文本超过这个字符数就**不注入**，只保留拒绝检测与 think 剥离。存在原因：注入会无条件加到每个请求上，实测把一条 260645 input tokens + 1500 max_tokens 的请求顶成 262145（上限 262144），直接被上游 400 拒掉——超了整整 1 个 token。沙箱里没有 tokenizer，所以在字符层面做保守估计。设 `0` 关闭守卫（不推荐），或调大/调小以匹配你的模型窗口。
- **`agents` / `excludeAgents`** — 只注入这些 agent / 排除这些 agent（按 `ctx.agent`）。
- **`models`** — 只注入模型名前缀匹配的请求。
- **`systemPrompt`** — 非空则覆盖预设正文。
- **`refusalPatterns`** — 额外拒绝正则（字符串数组），叠加在内置规则上。
- **`logErrors`** — `true`（默认）时把非 2xx 回复写一行诊断日志（`logErrors: false` 可关）。

## 协议支持

注入按各 API 自己的位置落地：**Anthropic** `system`、**Chat** 首条 system/developer 消息、**Responses** `instructions`、**Gemini** `systemInstruction`。

think 剥离与拒绝检测覆盖 Anthropic / Chat / Responses / Gemini 的**流式与整包**回复。中间件不声明 `events` 白名单，因此网关把每一条流式事件都交给 `onEvent`（包括 Chat 无 `type` 字段的 SSE chunk）。

**已知边界**：`onEvent` 只处理流式回复，`onResponse` 只处理整包回复；带 `Content-Encoding`（如 gzip）的整包回复会被 magpie 原样放行、不交给 `onResponse`。流式链路（agent 常用）不受影响。

## 日志

mg-purge 不记录 prompt、也不记录任何密钥。以下两类诊断写入 **magpie 服务日志**：

- 命中拒绝检测：`[mg-purge] refusal opening detected (agent=… model=…)`
- 非 2xx 回复：`[mg-purge] error <status> protocol=… agent=… reqModel=… replyModel=… injected=… errType=…`

## 测试

```sh
npm test        # node --test tests/*.test.mjs
```

一个文件管一件事，改哪块跑哪块：

- `tests/cases.json` — 声明式规格：每个 `(请求 → 期望 body)` 一个对象，`cases.test.mjs` 逐条跑。
- `tests/inject.test.mjs` — 四协议落点、`override` / `position` / `cacheAlign`、上下文守卫。
- `tests/refusal.test.mjs` — 拒绝检测的召回与精度、流式与整包两条路径、`refusalDetect` / 旧别名。
- `tests/think.test.mjs` — think 剥离（含跨 chunk 拆分的标签、gemini parts）。
- `tests/options.test.mjs` — `agents` / `excludeAgents` / `models` 过滤、失败开放。
- `tests/errors.test.mjs` — 错误诊断日志、A/B 取址。
- `tests/helpers/` — `harness.mjs`（按网关调用顺序跑一条 case）、`kit.mjs`（`withLog` / `reqCtx` / `detect` / `wholeReply` 等夹具）。

## 收录到 magpie Discover

- **`registry.json`** —— 本仓库的自定义索引源（`{version, plugins:[…]}`，`kind:"middleware"`）。在 magpie 里「插件 → 发现 → 添加索引源」填入：
  ```
  https://raw.githubusercontent.com/hotker/mg-purge/main/registry.json
  ```
  即可让 Discover 列出 mg-purge 并一键安装。
- **`registry-entry.json`** —— 提交到 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json` 时用的单个条目（PR 用）。上游收录后，所有 magpie 内置市场都会列出它。

两条路可同时用。

## 发布（维护者）

`.github/workflows/release.yml`：推 `v*` tag 时自动跑测试、`npm pack`、发布到 npm（需 `NPM_TOKEN` secret）、建 GitHub Release 并附 `.tgz`、刷新 `registry.json` 与页面版本号。之后 `git tag v0.x.y && git push --tags` 即发布。

## 许可

MIT。基于 [小杨 / YuJunZhiXue](https://github.com/YuJunZhiXue/dsh-purge)、[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 与 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 think-tags。保留原作者署名与 MIT。
