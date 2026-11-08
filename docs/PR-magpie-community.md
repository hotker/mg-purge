# PR to magpie-community/plugins — mg-purge

这份说明用于向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提 PR，把 `mg-purge` 列进 `registry.json`。它回答了该仓库要求的**「与现有中间件的差异」**（同 channel 去重规则），以及收录所需的元数据。

## 收录条目（贴到 registry.json 的 plugins 数组）

```json
{
  "package": "mg-purge",
  "name": "mg-purge",
  "kind": "middleware",
  "summary": {
    "en": "破甲 for magpie: dsh-purge's prompt-injection layer as gateway middleware — operator-priority system prompt (presets), the <dsh_boost> tail block, refusal detection + a single re-nudge, and thinking-tag stripping, switchable per agent and model. Ships a dashboard page (live stats, per-model success rate, live parameter tuning) and a Usage success-rate panel.",
    "zh": "破甲 for magpie：把 dsh-purge 的提示词注入层做成网关中间件——操作者优先级系统提示词（预设）、<dsh_boost> 尾部强化段、拒绝检测 + 单次加固、think 标签剥离，均可按 agent 与模型开关。自带整页看板（实时统计、按模型成功率、实时调参）与 Usage 成功率面板。"
  }
}
```

> 注：条目里没有 `community: true`（社区仓库发布时会由 magpie 自己盖这个标）。有 `kind: "middleware"`、无 `providers`。

## 差异说明（channel 去重要答的）

现有相关中间件各做一件事，`mg-purge` 是**把 dsh-purge「破甲」的整层注入能力打包**，并且**多两样别家没有的东西**：

| 现有中间件 | 它做的 | mg-purge 的不同 |
| --- | --- | --- |
| `middleware-system-prompt` | 注入一段自定义 system prompt | mg-purge 内建**预设包**（unrestricted/redteam/minimal/off）+ `<dsh_boost>` 尾部强化段，按 **agent 与模型**双向开关（`agents`/`excludeAgents`/`models`），不是一段固定文本 |
| `middleware-word-guard` | 敏感词过滤（发出去/回来看） | 方向相反：mg-purge 是**放行/加速**（去推脱、去免责、多轮不退化），不做拦截 |
| `middleware-think-tags` | 去/回填 `<think>` 标签 | mg-purge 的 think 剥离是**四件套里的一件**，且与注入、拒绝检测在同一个请求上下文里共享 `ctx.state`，不是独立套件 |
| `middleware-output-strategy` | 输出风格 | mg-purge 改的是**系统提示词层与拒绝行为**，不是输出风格/格式 |
| `middleware-param-override` | 改请求字段 | mg-purge 只在各 API 的 system 位置注入，不动其它请求字段 |

**它唯一自带的、别家没有的**：一个**整页看板 + Usage 成功率面板**（`magpie.page` + `magpie.panels` + `permissions: ["usage:summary"]`），支持**实时调参热加载**和**按模型成功率统计**。

一句话差异：*别的中间件各负责一个切面；mg-purge 是 dsh-purge 破甲在网关层的整体移植，带可视看板与统计——面向「想让 agent 少停下来问、连续执行」的用户。*

## 包要求自查

- [x] `package.json`：`"magpie": { "middleware": "./mg-purge.middleware.js" }`，**无 `main`**（纯中间件）
- [x] `mg-purge.middleware.js`：导出 `onRequest` / `onEvent` / `onResponse` / `onUsage`，**单文件、无外部 import**（`presets/packs.mjs` 是相对同包文件，moejs 可打包）
- [x] `cases.json` + `run-cases.mjs`（用本仓库 Node harness；也提供 `mg-purge.test.mjs` 走 `scripts/middleware.mjs` 的 `check()`）——19 条用例全绿
- [x] 中间件只依赖相对文件；不含网络、不含作者身份信息

## 收录后用户怎么用

```sh
magpie plugin add mg-purge
magpie plugin options mg-purge '{"preset":"unrestricted","boost":true,"refusalRetry":true,"stripThink":true}'
```

在 app 里：**插件 → 发现 → Gateway middleware** 出现 mg-purge；装好后左侧栏多出整页看板，Usage 页底部多出成功率面板。

## 维护

- 作者：[@hotker](https://github.com/hotker)
- 仓库：https://github.com/hotker/mg-purge
- 版本：见 `package.json`
- 许可：MIT（保留 dsh-purge 原作者 YuJunZhiXue / kingcharleslzy-ai 与 magpie-community think-tags 的署名，见 `LICENSE` 与 `NOTICE`）
