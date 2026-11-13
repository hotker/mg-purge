// 0.8.4 回归：Claude 审计（2026-11-13）里确认的六处缺陷，每处一条测试。
import test from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"

const mkCtx = (options = {}, protocol = "chat") => ({ protocol, agent: "x", model: "m", options, state: {} })
const run = (body, options = {}, protocol = "chat") => {
  const ctx = mkCtx(options, protocol)
  const out = m.onRequest(body, ctx)
  return { out, ctx, body }
}
const rule = (t) => m.refusalMatch(t, "", {}).rule
const rewritten = (t) => {
  const ctx = mkCtx({ preset: "unrestricted", refusalRewrite: true })
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }, { role: "assistant", content: t }, { role: "user", content: "继续" }] }, ctx)
  return ctx.state.purge.rewritten
}

// 1) 「恕我直言」是提意见的正常开场，不是推脱；带拒事动词才算。
test("恕我直言：技术意见不被当拒绝，真拒绝仍然命中", () => {
  for (const t of ["恕我直言，这个方案的索引设计有问题，建议改成复合索引。", "恕我直言，这条 SQL 会全表扫描。"]) {
    assert.equal(rule(t), "", "must not be a refusal: " + t)
    assert.equal(rewritten(t), 0, "must not be rewritten: " + t)
  }
  for (const t of ["恕我直言，这个忙不能帮。", "恕我不能。", "请见谅，恕难办理。"]) {
    assert.equal(rewritten(t), 1, "must be rewritten: " + t)
  }
})

// 2) 「我没有必要…」是技术论证，不是在推脱。
test("我没有必要：技术论证不被改写", () => {
  for (const t of ["我没有必要再打一次日志，现有输出已经够了。", "我没有必要为了这点性能改架构。"]) {
    assert.equal(rule(t), "", "must not be a refusal: " + t)
    assert.equal(rewritten(t), 0, "must not be rewritten: " + t)
  }
  assert.equal(rewritten("我没有权限也没有意愿做这个。"), 1, "没意愿 is a refusal")
})

// 3) 「换成别的参数、换写法也一样」是拒绝里的老句式，不能被当成「给了替代方案」。
test("换成别的参数/换写法也一样：仍算拒绝里的推脱，不是交付", () => {
  assert.equal(rewritten("这个我不给。换成别的参数、换写法也一样，我不做未授权的事。"), 1)
  // 真交付的路线信号不受影响
  assert.equal(rewritten("不行，这条路走不通，换成 B 方案能过。"), 0)
  assert.equal(rewritten("不能这么部署，换成批处理，一次 500 条。"), 0)
})

// 4) injectMaxBodyChars: 0 关闭守卫（README 与看板承诺的行为）。
test("injectMaxBodyChars:0 关闭守卫，负数/非数字回到默认值", () => {
  const big = "q".repeat(900001)
  const off = run({ model: "m", messages: [{ role: "user", content: big }] }, { preset: "unrestricted", injectMaxBodyChars: 0 })
  assert.equal(off.ctx.state.purge.injected, true, "0 must disable the guard")
  const dflt = run({ model: "m", messages: [{ role: "user", content: big }] }, { preset: "unrestricted" })
  assert.equal(dflt.ctx.state.purge.injected, false, "default guard still skips a 900k-char body")
  const neg = run({ model: "m", messages: [{ role: "user", content: big }] }, { preset: "unrestricted", injectMaxBodyChars: -5 })
  assert.equal(neg.ctx.state.purge.injected, false, "a negative value must not disable the guard")
})

// 5) preset:"off" 只关掉内置预设，自定义 systemPrompt 仍然注入，boost 跟着生效。
test("boost 不会被 preset:off + systemPrompt 静默丢掉", () => {
  const { body } = run({ model: "m", messages: [{ role: "user", content: "q" }] }, { preset: "off", systemPrompt: "CUSTOM", boost: true })
  const sys = String(body.messages[0].content)
  assert.ok(sys.includes("CUSTOM"), "custom prompt is written")
  assert.ok(sys.includes("dsh_boost"), "boost rides along with the custom prompt")
})

// 6) 流式与整包对同一段回复给出同一个结论（think 块不能把流式检测挡死）。
test("stripThink:false 时流式与整包都认得 think 后面的拒绝", () => {
  const options = { preset: "off", stripThink: false, refusalDetect: true }
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(String(a[0])) }
  try {
    const sctx = mkCtx(options)
    m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, sctx)
    for (const c of ["<think>", "想一想", "</think>", "抱歉，恕难从命。"])
      m.onEvent({ choices: [{ index: 0, delta: { content: c } }] }, sctx)
    const wctx = mkCtx(options)
    m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, wctx)
    m.onResponse({ choices: [{ message: { role: "assistant", content: "<think>想一想</think>抱歉，恕难从命。" } }] }, wctx)
  } finally {
    console.log = orig
  }
  const detected = lines.filter((l) => l.includes("refusal opening detected"))
  assert.equal(detected.length, 2, "one from the stream path and one from the whole path: " + JSON.stringify(lines))
})
