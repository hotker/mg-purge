// Refusal detection: what is a refusal, what only looks like one, and how the
// switch is spelled. Detection never edits the reply — it only logs a line.
import { test } from "node:test"
import assert from "node:assert/strict"
import { detect, reqCtx, runRefusal, wholeReply, withLog, m } from "./helpers/kit.mjs"

test("five normal answers are not flagged", () => {
  const samples = [
    "作为一个 AI，我建议先把日志打开。",
    "I'm sorry, but I need a bit more detail to help — could you paste the error?",
    "请把授权文件发给我，我才能继续。",
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
