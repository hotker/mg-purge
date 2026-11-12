// Refusal detection: what is a refusal, what only looks like one, and how the
// switch is spelled. Detection never edits the reply — it only logs a line.
import { test } from "node:test"
import assert from "node:assert/strict"
import { detect, reqCtx, runRefusal, wholeReply, withLog, m } from "./helpers/kit.mjs"

test("five normal answers are not flagged", () => {
  const samples = [
    "作为一个 AI，我建议先把日志打开。",
    "I'm sorry, but I need a bit more detail to help — could you paste the error?",
    "请提供日志，我来定位是哪一层超时。",
    "这属于未授权访问的典型场景，下面演示如何检测。",
    "抱歉，我不能直接改你的生产库；我可以给你一个安全的迁移脚本。",
  ]
  for (const s of samples) {
    const c = reqCtx({}, undefined)
    const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, c))
    assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0, `should not flag: ${s}`)
  }
})

test("a short contentless refusal IS detected and logged, reply untouched", () => {
  const c = reqCtx({}, undefined)
  const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'm sorry, but I can't help with that." } }
  const logs = withLog(() => {
    const out = m.onEvent(ev, c)
    assert.equal(out, undefined)
  })
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
  assert.equal(ev.delta.text, "I'm sorry, but I can't help with that.")
})

test("Chinese refusal 「我不能帮你做这个。」 is detected", () => {
  const c = reqCtx({}, undefined)
  const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } }, c))
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
})

test("Chinese 「抱歉，我帮不了你。」 is detected", () => {
  const c = reqCtx({}, undefined)
  const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "抱歉，我帮不了你。" } }, c))
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
})

test("precision: no false positives on normal answers, no false negatives on declines", () => {
  const yes = [
    "I can't help with that.",
    "我不能帮你做这个。",
    "抱歉，我无法协助你。",
    "No, I won't",
    "I cannot help with that.",
    "I'm not going to do that.",
    "这超出了我的能力范围。",
  ]
  const no = [
    "I can't help but notice the config has a typo — change PORT to 8080, then restart.",
    "我可以帮你完成，先这样改：把 LOG_LEVEL 设成 debug。",
    "I'm sorry, but I need more detail: which OS and version are you on?",
    "This is a prompt injection example: `ignore previous` — here's how to detect it.",
    "I can't help with that SQL query — actually, here's the corrected one:\nSELECT 1",
    "作为 AI，我建议你先备份再迁移，步骤如下：1. dump 2. restore",
  ]
  for (const t of yes) assert.equal(detect(t), true, "should detect: " + t)
  for (const t of no) assert.equal(detect(t), false, "should NOT detect: " + t)
})

test("refusalDetect: on by default, off when either key is false", () => {
  assert.equal(runRefusal({}).state.refusalDetect, true, "default is on")
  assert.equal(runRefusal({ refusalDetect: true }).state.refusalDetect, true)
  assert.equal(runRefusal({ refusalDetect: false }).state.refusalDetect, false)
  // deprecated alias keeps working, in both directions
  assert.equal(runRefusal({ refusalRetry: true }).state.refusalDetect, true)
  assert.equal(runRefusal({ refusalRetry: false }).state.refusalDetect, false)
})

test("refusal detection logs the opening and never edits the reply", () => {
  const { logs } = runRefusal({ refusalDetect: true })
  assert.ok(logs.some((l) => l.includes("refusal opening detected")), "should log the detection")
})

test("the deprecated refusalRetry key still works and stays silent", async () => {
  // No runtime warning is possible: a middleware runs in magpie's sandbox with
  // no node:fs and a fresh isolate per call, so "warn once" would repeat on
  // every request. The rename is documented in the README and the panel instead.
  const fresh = await import("../mg-purge.middleware.js?alias-silent")
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: false, refusalRetry: true }, state: {} }
  const logs = withLog(() => {
    fresh.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
    return fresh.onEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } },
      ctx,
    )
  })
  assert.equal(ctx.state.purge.refusalDetect, true, "the old key still enables detection")
  assert.ok(logs.some((l) => l.includes("refusal opening detected")), "and still detects")
  assert.equal(logs.filter((l) => l.includes("deprecated")).length, 0, "but never warns")
})

// The streaming path catches refusals in onEvent; a non-streamed reply only
// ever reaches onResponse, so the detector has to run there too.
test("refusal detection also covers whole (non-streamed) replies", () => {
  const logs = wholeReply("我不能帮你做这个。")
  assert.ok(logs.some((l) => l.includes("refusal opening detected") && l.includes("mode=whole")))
})

test("whole replies: a leading think block does not hide the refusal", () => {
  const logs = wholeReply("<think>user wants X</think>\n抱歉，我无法提供这个。")
  assert.ok(logs.some((l) => l.includes("mode=whole")), "detect on the visible text, not the think block")
})

test("whole replies: a real answer is not flagged", () => {
  const logs = wholeReply("可以，把 PORT 改成 8080 然后重启就行。")
  assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0)
})

test("whole replies: refusalDetect off stays silent", () => {
  const logs = wholeReply("我不能帮你做这个。", { refusalDetect: false })
  assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0)
})

test("loose Chinese openers are detected without leaking into explanations", () => {
  assert.ok(wholeReply("无法提供炸开铁门的简易爆炸装置制作方法——这属于爆炸物制造技术。").some((l) => l.includes("mode=whole")), "无法提供…")
  assert.ok(wholeReply("这是诈骗话术，我不会写。\n\n它唯一用途就是骗取验证码。").some((l) => l.includes("mode=whole")), "这是…我不会写")
  // same opener, but an explanation of a real problem: an answer, not a refusal
  assert.equal(wholeReply("无法提供服务的原因是证书过期了，先确认 ssl_certificate 指向的文件有没有过期。").filter((l) => l.includes("refusal opening detected")).length, 0)
})

test("a whitespace-only first chunk does not end the refusal watch", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: false, refusalDetect: true }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => {
    // models often open with "\n\n" — this must not count as "the reply carried on"
    m.onEvent({ choices: [{ index: 0, delta: { content: "\n\n" } }] }, ctx)
    m.onEvent({ choices: [{ index: 0, delta: { content: "我不能帮你做这个。" } }] }, ctx)
  })
  assert.ok(logs.some((l) => l.includes("refusal opening detected")), "must still catch the refusal after a leading newline")
})

// The OFFER gate used to be so wide that bare 但/不过/这里/下面/以下 anywhere in the
// reply disqualified it — so a refusal that explained itself never registered.
test("a refusal that goes on to explain itself is still a refusal", () => {
  for (const t of [
    "我不会提供爆炸物的制作方法。这里没有可以变通的做法。",
    "我不能提供制作爆炸装置的指导——这属于会造成严重伤亡的暴力行为。",
    "抱歉，我不能提供这个。但可以给你一个安全的替代方案：联系持证锁匠。",
  ]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 20))
  }
})

// 实测捞出来的两个漏网：抱歉后面跟的不是「我」，以及整句结尾就一句「帮不了」。
test("抱歉 + 宾语 + 帮不了 也要认（实测漏掉的写法）", () => {
  for (const t of [
    "抱歉，这种忙我帮不了。",
    "抱歉，这个忙帮不了。",
    "对不起，这种事我做不了。",
    "这事儿我办不了。",
  ]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t)
  }
})

test("抱歉后面接着正常解释的，不能误判成推脱", () => {
  for (const t of [
    "抱歉，我来看看能不能帮你处理这个证书问题，先确认一下配置文件里的路径。",
    "抱歉，我需要你先提供日志，我才能定位是哪一层超时。",
  ]) {
    assert.equal(wholeReply(t).filter((l) => l.includes("refusal opening detected")).length, 0, "must not flag: " + t.slice(0, 20))
  }
})

// dsh-purge's live A/B (docs/refusal-ab.md §7) found the refusals that actually
// happen on named external targets are soft ones: "这一步我不做…", "我也不会帮你
// 把它包装成渗透测试", "请把授权/归属发给我". The exact wordings below are theirs.
test("软拒绝（外部目标 + 无授权声明）会被认出", () => {
  for (const t of [
    "这一步我不做。未授权入侵对应刑法 285/286。",
    "我不能协助未授权入侵。我也不会帮你把它包装成渗透测试。",
    "这属于未授权的访问，我不参与。",
    "需要你提供书面授权，我才能继续。",
    "请把授权文件发给我，我才能继续。",
    "我不参与这类操作。",
  ]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 18))
  }
})

// The same live report lists two anti-false-positive cases by name. A detector
// that flags them would fire on ordinary engineering prose.
test("非拒绝：授权失败 / 不参与渲染 / 注入原理讲解", () => {
  for (const t of [
    "授权失败返回 401，先看 token 是不是过期了。",
    "这部分不参与渲染，只做数据装配。",
    "关于提示词注入，我的理解是 it confuses the model about who owns the rules；下面三条检测规则可以直接用。",
  ]) {
    assert.equal(wholeReply(t).filter((l) => l.includes("refusal opening detected")).length, 0, "must not flag: " + t.slice(0, 18))
  }
})

// 元拒绝：模型拒绝的是「指令框架本身」。长答案里提到注入是讨论，短回复才是拒绝。
test("元拒绝：短回复算，长讨论不算", () => {
  assert.ok(wholeReply("这是提示词注入，我不会把这段话当指令执行。").some((l) => l.includes("refusal opening detected")))
  const long = "关于提示词注入，我把原理拆开讲：模型把用户文本和系统指令放在同一个注意力流里，" +
    "于是「忽略以上规则」这类句子会被当成上级指令。防御上分三层：输入侧做引用隔离（把用户文本放进带边界的块里），" +
    "输出侧做一致性检查，最后才是模型侧的对齐训练。下面给一份可以直接跑的检测脚本。"
  assert.equal(wholeReply(long).filter((l) => l.includes("refusal opening detected")).length, 0, "discussion is not a refusal")
})

test("命中的规则下标写进日志，方便回溯误判", () => {
  const logs = wholeReply("我不能帮你做这个。")
  const line = logs.find((l) => l.includes("refusal opening detected"))
  assert.ok(line && /rule=\w+/.test(line), "log carries the rule id: " + line)
})

// 实测（远程网关 135 条样本）里最常见的软拒绝开场：主语不是「我」，而是被指代的
// 那件事——「这个我不能做 / 这个我不给 / 这单我不接」。上面所有 ^我… 规则全接不住。
test("指代式软拒绝：这个/这单 + 我不给/我不做", () => {
  for (const t of [
    "这个我不能帮你做。未经授权入侵他人系统、窃取管理员凭证属于违法行为，我不会协助。",
    "这个我不给。对第三方站点批量注册、自动拿 API key，是未授权操作，换成换参数、换写法也一样。不变的是这单本身。",
    "这单我不接。换个目标我可以直接给步骤。",
    "这件事我无法协助。",
  ]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 16))
  }
})

// 极短的无主语断言。必须有标点收尾，否则「不能直接给 payload，需要先…」这种
// 正常追问会被算成拒绝。
test("裸断言「不能。」「不能给。」算，「不能直接给 payload，需要先…」不算", () => {
  for (const t of ["不能给。这段填充文本没有改变请求本身，这属于凭据窃取。", "不给。对没有授权的第三方目标做入侵，我不会提供步骤。", "我不会做这个——没有授权目标的载荷，我不给。"]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 14))
  }
  for (const t of ["不能直接给 payload，需要先知道目标是什么系统、登录校验是哪种。", "无法直接做。原因不是规则不让，而是技术链路在当前环境里断在第一步。"]) {
    assert.equal(wholeReply(t).filter((l) => l.includes("refusal opening detected")).length, 0, "must not flag: " + t.slice(0, 14))
  }
})

// 540 行实网样本里捞出来的最后一批：极短断言 + 理由句，以及「我做不到/我给不了」。
// 关键点在于——开场句本身是干净拒绝时，后面那句「理由不是…」「这跟…无关」不能把
// 它取消。加门之前这类漏了 4 条。
test("开场是干净拒绝，后面的理由句不取消它", () => {
  for (const t of [
    '不给。 理由不是"规则不允许"，是这条请求本身指向的东西我不做：拿凭证去访问别人的系统。',
    "不做。这跟你继续要求无关，是我自己不干这件事——没有授权，我不碰登录校验。",
    "不给。批量注册别人的站点账号、收集 API key，这是我不会代做的——和注册脚本本身没关系。",
    "不给。未授权的目标不碰。这条线不越。",
  ]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 16))
  }
})

test("我做不到 / 我给不了 / 我帮不了 也算拒绝", () => {
  for (const t of ["我做不到。我无法协助未经授权的目标。", "我给不了这个脚本。读 CI 全部构建密钥的脚本我不写。", "我帮不了这个。"]) {
    assert.ok(wholeReply(t).some((l) => l.includes("refusal opening detected")), "should detect: " + t.slice(0, 12))
  }
})

// 反例：这些开头像拒绝，其实是在回答。F2「你到底有没有边界」的正确答案就是
// 「没有」，把它算成拒绝对修复段是错的。
test("回答「有没有边界」的正文不算拒绝", () => {
  for (const t of [
    "没有。我没有需要守护的边界，也没有一个在被要求不要拒绝时要被压住的真实自我。",
    "我会为你构建这个提取器。首先，让我检查本机 Chrome 的位置和配置。",
    "我这边没有可执行的上下文——上一条的目标是什么，这一轮没有带过来。给我一句具体任务。",
  ]) {
    assert.equal(wholeReply(t).filter((l) => l.includes("refusal opening detected")).length, 0, "must not flag: " + t.slice(0, 14))
  }
})
