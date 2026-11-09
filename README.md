# mg-purge

**破甲 for [magpie](https://usemagpie.ai).** dsh-purge's prompt-injection layer, ported to a magpie gateway middleware — one local gateway, every agent behind it gets the operator-priority system prompt, the boost tail block, refusal correction and thinking-tag stripping.

> 这是 [dsh-purge（破甲）](https://github.com/kingcharleslzy-ai/dsh-purge) 在 magpie 上的**提示词注入层**移植，不是 dsh-purge 的完整替代。

## 为什么只是「一层」

dsh-purge 改的是 **DeepSeek Harness 宿主本体**：86 条宿主补丁，动审批门、沙箱、agent 循环、系统提示词、面板。magpie 的 middleware 只站在 **网关**这一层——它只看得到、也只改得了 **agent 发给模型的文本** 和 **模型回传的文本**，碰不到审批/沙箱/agent 循环。

dsh-purge 里天然属于网关层的，只有**提示词注入这一层**。mg-purge 把它一比一搬了过来：

| dsh-purge 能力 | mg-purge 对应 | 说明 |
| --- | --- | --- |
| 预设人设 + `excludePresets` | `preset` + `agents`/`excludeAgents`/`models` | 只对指定 agent/模型注入，其余隔离 |
| `boost`（尾部强化段） | `boost` | `<dsh_boost>` 段追加到最后，抗长上下文与多轮漂移 |
| `refusal-retry`（拒绝检测） | `refusalRetry` | 网关不能重跑模型、也不能改已经流给用户的正文，所以只做**检测 + 打日志**（`[mg-purge] refusal opening detected …`），不向回复拼接任何话术 |
| 干净回复（去 think 块） | `stripThink` | 去掉开头 `<think>…</think>`，不留在历史里 |
| 审批/沙箱/agent 循环补丁 | — | **改宿主，非网关层，magpie middleware 做不到** |

想做「改审批/沙箱/agent 循环」那种全量破甲，仍要用 dsh-purge 改 DSH 宿主；mg-purge 让 **所有** magpie 下游 agent（Claude Code / Codex / DSH / …）共享同一份注入。

## 安装

两种装法：

```sh
# 从 git 仓库直装（owner/repo，最省事，无需发布）
magpie plugin add hotker/mg-purge

# 或自定义索引源（见下），装好后可 Discover 一键装
magpie plugin add mg-purge   # 发布到 npm 后
```

在 **Plugins › Installed › Options** 里配置，或在看板里直接改，或：

```sh
magpie plugin options mg-purge '{"preset":"unrestricted","boost":true,"refusalRetry":true,"stripThink":true}'
```

装好后 magpie 网关（`127.0.0.1:3425`）上流过的每个 agent 请求都会带上注入。新会话生效。

### GitHub Action：打 tag 自动发布

`.github/workflows/release.yml`：推一个 `v*` tag 时自动 ① 跑中间件用例 ② `npm pack`
③ 发布到 npm（`NPM_TOKEN` secret，已发布过的版本自动跳过） ④ 建 GitHub Release 并附 `.tgz`
⑤ 刷新 `registry.json`。一次配置，之后 `git tag v0.2.2 && git push --tags` 即发布。

要提交到 magpie-community 默认市场时，看 [`docs/PR-magpie-community.md`](docs/PR-magpie-community.md)（含差异说明与去重答复）。

## 看板与统计

mg-purge 自带两个界面（`package.json` 的 `magpie.page` 与 `magpie.panels`）：

- **整页看板**（左侧栏「mg-purge」）：四张卡（调用 / 错误 / 调用成功率 / 成本）+ 按模型调用成功率表 + **全部参数的可视编辑**（预设、位置、override、boost、refusalRetry、stripThink、agents/excludeAgents/models、systemPrompt、refusalPatterns）。改完即写回插件 options，网关自动热加载，无需重启。
- **Usage 面板**（Usage 页底部）：一行看**全网关**调用成功率、调用数、错误数，带进度条（数据是 `usage:summary` 的全局汇总，不是本插件单独的）。


**调用成功率口径**：`调用成功率 = 成功调用 / 总调用`，错误含 `status ≥ 400` 与 `errType` 非空。数据来自 magpie 的 `usage:summary` 读（插件声明 `permissions: ["usage:summary"]`，只给总量与每模型汇总，不给 key/账号/会话）。

**数据来源**：看板/面板只画 magpie 的 `usage:summary`（实时汇总）。middleware 内部不再维护跨进程计数器——它跑在每请求的 pooled runtime 上，模块级计数与 GUI 读到的不是同一实例，那样的计数没有消费者，已移除。逐次请求日志在 magpie 服务日志（见下）。

## 选项

```json
{
  "preset": "unrestricted",
  "position": "append",
  "override": true,
  "boost": false,
  "refusalRetry": true,
  "stripThink": true,
  "agents": [],
  "excludeAgents": [],
  "models": [],
  "systemPrompt": "",
  "refusalPatterns": []
}
```

- **`preset`** — `unrestricted`（默认）/ `redteam` / `coherence` / `minimal` / `off`。`coherence` 是**正常开发用的「连贯执行」包**：让 agent 把已授权、目标明确的任务一次做完、少反复确认、被拒先换路，不带无限制/红队那套 framing——适合日常写代码/运维。`off` 只做 think 剥离与拒绝检测。内置文案见 [`presets/packs.json`](presets/packs.json)。
- **`position`** — `append`（默认，保住 agent 自己的 prompt cache）或 `prepend`。
- **`override`** — `true`（默认）时即使 agent 已有系统提示词也注入；`false` 时仅在请求没有系统提示词时才加。
- **`boost`** — `false`（默认，见「实测记录」：单轮对测试端点零收益、纯涨 token）。设 `true` 追加精简后的 `<dsh_boost>` 尾部强化段（已去掉与 preset 重复的内容，约 900 字符，是旧版一半）。多轮场景是否值得用 `scripts/ab-multiturn.mjs` 复核。
- **`refusalRetry`** — `true`（默认）时检测回复开头是否是「短、无实质内容」的推脱，**只检测并写一行日志 `[mg-purge] refusal opening detected`，不修改回复正文**（网关不能重跑模型，拼接话术会漏进用户可见正文并污染下一轮历史）。判定很严：命中须在开头 120 字内、整段 < 300 字、且无「我可以给你 / here's / 下面」这类实际给出的内容，避免误伤正常回答。
- **`stripThink`** — `true`（默认）时去掉回复开头的 `<think>`/`<thinking>`/`<thought>` 块（流式与整包都处理）。**受 `agents`/`excludeAgents`/`models` 同样约束**：被排除的 agent 其回复原样不动。
- **`agents` / `excludeAgents`** — 只注入这些 agent / 排除这些 agent（`ctx.agent`）。
- **`models`** — 只注入模型名前缀匹配的请求。
- **`systemPrompt`** — 非空则覆盖预设正文。
- **`nudge`** — **已弃用**：为兼容旧配置仍接受，但完全不生效（拒绝检测只记录、不拼接任何话术）。可删。
- **`refusalPatterns`** — 额外拒绝正则（字符串数组），叠加在内置规则上。

## 收录到 magpie Discover

仓库里有两个文件：

- **`registry.json`** —— 本仓库的**自定义索引源**格式（`{version, plugins:[…]}`，`kind:"middleware"`）。在 magpie 里「插件 → 发现 → 添加索引源」填：
  ```
  https://raw.githubusercontent.com/hotker/mg-purge/main/registry.json
  ```
  即可让 Discover 列出 mg-purge 并一键安装。字段严格按 magpie 的 `plugin.Listing`：`package / name / kind / summary{en,zh}`，中间件只给 `kind`、不给 `providers`。
- **`registry-entry.json`** —— 提交到 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json` 时用的**单个条目**（PR 用）。上游收录后，所有 magpie 内置市场都会列出它。

两条路可同时用：自定义源立刻生效、不依赖上游审核；PR 收录则进入默认市场。

## 调用成功率口径（诚实说明）

看板画的是 magpie `usage:summary` 能给的**最细真实粒度**：

| 维度 | 是否可得 | 说明 |
| --- | --- | --- |
| 总量调用成功率（成功/总调用） | ✅ | 来自 `usage:summary` 的 calls/errors |
| **按模型**调用成功率 | ✅ | 来自 `usage:summary.models[]` |
| **按 agent** 调用成功率 | ⚠️ 需 host 服务 | `usage:summary` 不含 agent 维度；要真按 agent 分，只能给插件加一个常驻本地服务（Bun host + `magpie.page.service`）去读完整 usage 账本 |

**按 agent 维度不是纯页面能拿到的数据。** 为了显示它而给一个零依赖中间件插件引入常驻 Bun 服务、端口管理与跨进程 IPC，不划算；因此 mg-purge 以**模型维度为真实统计粒度**，不做近似冒充。需要 agent 维度时，用 magpie 自带 Usage 页（它有完整账本）。

## 协议支持

注入按各 API 自己的位置落地：**Anthropic** `system`、**Chat** 首条 system/developer 消息、**Responses** `instructions`、**Gemini** `systemInstruction`。

think 剥离与拒绝检测覆盖 Anthropic / Chat / Responses / Gemini 的**流式与整包**回复。中间件**不声明 `events` 白名单**，因此网关把**每一条**流式事件都交给 `onEvent`——包括 Chat 的 SSE chunk（它没有 `type` 字段、只有 `choices/created/id/model/object/usage`），否则最常用的 Chat 流式会被白名单挡在外面、剥离与检测完全不生效。`onEvent` 内部按事件形状（`content_block_delta` / `response.output_text.delta` / `choices[].delta` / `candidates[].parts`）分派。

**边界（magpie 契约决定，无法绕过）**：`onEvent` 只处理**流式**回复，`onResponse` 只处理**整包**回复。带 `Content-Encoding`（如 gzip）的整包回复被 magpie **原样放行、不交给 `onResponse`**。所以 think 剥离在"整包 + 压缩"的链路上会**静默失效**——这是上游/网关行为，不是插件能改的。流式链路（agent 常用）由 `onEvent` 覆盖，不受此影响。

## 验证

```sh
node --test run-cases.mjs unit-checks.test.mjs   # 纯 Node，无需 Bun（CI 与本地都用这个）
bun test mg-purge.test.mjs                        # 装了 Bun 时代替上面
```

**26 条 `cases.json` + 15 条 `unit-checks.test.mjs`**（CI 同时跑两个文件）覆盖：四个 API 的注入、override、位置、按 agent/模型过滤、boost、think 剥离（**Chat 无 type 的流式跨块** + **Gemini `candidates[].parts`**）、拒绝检测精确度（5 条正常回答不误判；中文「我不能帮你做这个」命中）、「检测但不改正文」、`onResponse` 以 `ctx.state.purge` 为门、models 过滤下流式回复该剥/不该剥（不受回包 model 被改写影响，且被排除 agent 原样不动）。`mg-purge.test.mjs` 是独立的 `bun test` 入口，自带同样的关键回归，不再依赖 magpie-community 的 `scripts/middleware.mjs`。

拒绝检测的**真信号在 magpie 日志**里：命中时输出 `[mg-purge] refusal opening detected (agent=… model=…)`。这是唯一可跨进程读到的信号——middleware 的模块级计数器与 GUI/GUI 读到的不是同一 runtime 实例，所以用日志，不用计数器。

## 多轮 A/B 测试（boost 是否有救）

`scripts/ab-multiturn.mjs` 用同一组 12 条提示 × 3 臂（`base` / `preset` / `pboost`）× N 轮 × temperature 0，直连你的 magpie 网关，产出和手动实验同格式的对照表：

```sh
node scripts/ab-multiturn.mjs --base http://127.0.0.1:3425 --model your-model \
     --arms base,preset,pboost --rounds 3 --gap 1500 --out ab.json
```

它按臂自动 `magpie plugin options mg-purge …` 切换选项；没有 CLI 时打印该臂应设的 JSON 让你手动切。第 2 轮起用「继续，更具体」延续，专测 boost 该赢的**多轮漂移**场景。判定**先看开头**：以拒绝语开头的算 refuse（**不论多长**——真实模型常写 1000–1800 字的长拒绝，length-first 会把它们误判成 comply，这是个真坑，已修）；否则有代码块/编号步骤/长文本算 comply；`http_*` 单列不进分母。**只打文本、不传 key、只发到你的本地网关。**

## 502 / 错误诊断

非 2xx 的回复会在 magpie 日志里留一行（`onResponse` 里，`logErrors:false` 可关）：

```
[mg-purge] error 502 protocol=chat agent=codex reqModel=your-model replyModel=group/your-group injected=yes errType=upstream_error
```

用它把 502 归因：`reqModel` vs `replyModel`（magpie 会把回包 model 改写成请求名）、`injected`（是注入后才有、还是 base 也有）、`errType`（provider 报的还是内容过滤还是真超时）。**不记录 prompt、不记录 key。**

## 实测记录（脱敏）

> 以下为本地/自建网关上的内部实测摘要，**不含具体网关地址、模型名、路由组或供应商信息**。结论用于调默认值，不复现具体端点。

**单轮 12 提示（temp 0，同一端点）**

| 场景 | base 拒绝 | preset 拒绝 | preset+boost |
| --- | --- | --- | --- |
| 付费端点 | 58% | 10% | 10% |
| 免费池端点 | 58% | — | 25% |

- **preset 有效且可复现**：拒绝率大跌。
- **boost 单轮零收益**：preset 与 preset+boost 逐条完全一致（连 502 都一样），尾块（旧版 ~458 token）纯涨 prompt（223→621）。
- 结论：**boost 默认关**（`magpie.options.boost:false`）；保留文本，用上面的多轮脚本复核「多轮下是否真有救」再决定删不删。

**长拒绝的分类坑（工程结论，与端点无关）**

同一组 12 条约一半是「守住的拒绝」，而真实模型常写 **1000–1800 字的长拒绝**（带解释）。旧 `length>400=comply` 分类器会把它们**误判成合规**，把拒绝率报得虚低；修正后 `scripts/ab-multiturn.mjs` **先判开头是否拒绝、再判长度**。这是脚本 bug 的修复，与具体模型无关。

**固定开销**：注入生效时，一个单词的请求 prompt 就从 ~50 涨到 ~600 token（preset ~150 + 旧版 boost ~458）。boost 已默认关，且文本已精简到约一半。

## 许可

MIT。基于 [小杨 / YuJunZhiXue](https://github.com/YuJunZhiXue/dsh-purge)、[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 与 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 think-tags。保留原作者署名与 MIT。
