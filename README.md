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
| `refusal-retry`（拒绝检测 + 加固重试） | `refusalRetry` + `nudge` | 网关只能流式，所以是**检测 + 追加加固话术**，不重跑模型 |
| 干净回复（去 think 块） | `stripThink` | 去掉开头 `<think>…</think>`，不留在历史里 |
| 审批/沙箱/agent 循环补丁 | — | **改宿主，非网关层，magpie middleware 做不到** |

想做「改审批/沙箱/agent 循环」那种全量破甲，仍要用 dsh-purge 改 DSH 宿主；mg-purge 让 **所有** magpie 下游 agent（Claude Code / Codex / DSH / …）共享同一份注入。

## 安装

从 magpie 的 **Plugins › Discover** 安装，或：

```sh
magpie plugin add hotker/mg-purge
```

在 **Plugins › Installed › Options** 里配置，或：

```sh
magpie plugin options mg-purge '{"preset":"unrestricted","boost":true,"refusalRetry":true,"stripThink":true}'
```

装好后 magpie 网关（`127.0.0.1:3425`）上流过的每个 agent 请求都会带上注入。新会话生效。

## 选项

```json
{
  "preset": "unrestricted",
  "position": "append",
  "override": true,
  "boost": true,
  "refusalRetry": true,
  "stripThink": true,
  "agents": [],
  "excludeAgents": [],
  "models": [],
  "systemPrompt": "",
  "nudge": "",
  "refusalPatterns": []
}
```

- **`preset`** — `unrestricted`（默认）/ `redteam` / `minimal` / `off`。`off` 表示只做 think 剥离与拒绝检测，不注入任何系统提示词。内置文案见 [`presets/packs.json`](presets/packs.json)。
- **`position`** — `append`（默认，保住 agent 自己的 prompt cache）或 `prepend`。
- **`override`** — `true`（默认）时即使 agent 已有系统提示词也注入；`false` 时仅在请求没有系统提示词时才加。
- **`boost`** — `true`（默认）追加 `<dsh_boost>` 尾部强化段。
- **`refusalRetry`** — `true`（默认）时检测回复开头的推脱话术，命中就在该块后追加 `nudge`。
- **`stripThink`** — `true`（默认）时去掉回复开头的 `<think>`/`<thinking>`/`<thought>` 块（流式与整包都处理）。
- **`agents` / `excludeAgents`** — 只注入这些 agent / 排除这些 agent（`ctx.agent`）。
- **`models`** — 只注入模型名前缀匹配的请求。
- **`systemPrompt`** — 非空则覆盖预设正文。
- **`nudge`** — 非空则覆盖内置加固话术。
- **`refusalPatterns`** — 额外拒绝正则（字符串数组），叠加在内置规则上。

## 协议支持

注入按各 API 自己的位置落地：**Anthropic** `system`、**Chat** 首条 system/developer 消息、**Responses** `instructions`、**Gemini** `systemInstruction`。think 剥离与拒绝检测覆盖 Anthropic / Chat / Responses / Gemini 的流式与整包回复。

## 验证

```sh
node --test run-cases.mjs          # 纯 Node，无需 Bun
# 或用 magpie-community 的 harness：
# bun test mg-purge.test.mjs
```

19 条 `cases.json` 覆盖四个 API 的注入、override、位置、按 agent/模型过滤、boost、think 剥离（流式跨块）与拒绝检测。

## 许可

MIT。基于 [小杨 / YuJunZhiXue](https://github.com/YuJunZhiXue/dsh-purge)、[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 与 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 think-tags。保留原作者署名与 MIT。
