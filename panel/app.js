// mg-purge's panel in magpie's Usage page: today's success rate at a glance.
(async () => {
  await magpie.ready
  const $ = (id) => document.getElementById(id)
  let enabled = true
  try {
    const o = await magpie.options.get()
    enabled = !o || o.preset !== "off"
  } catch { enabled = true }

  const dot = $("dot")
  dot.classList.toggle("on", enabled)
  $("preset").textContent = enabled ? "运行中" : "已关闭注入"

  let s
  try {
    s = await magpie.read("usage:summary", { period: "today" })
  } catch (err) {
    $("rate").textContent = "读取失败"
    $("foot").textContent = String(err && err.message ? err.message : err)
    return
  }
  const calls = s.calls || 0
  const errors = s.errors || 0
  const ok = Math.max(0, calls - errors)
  const rate = calls ? ok / calls : 1
  $("calls").textContent = `${calls.toLocaleString()} 次调用`
  $("rate").textContent = calls ? (rate * 100).toFixed(1) + "%" : "—"
  const fill = $("barFill")
  fill.style.width = (rate * 100).toFixed(1) + "%"
  fill.classList.toggle("low", rate < 0.9)
  $("foot").textContent = `今天 · 成功 ${ok.toLocaleString()} / 错误 ${errors.toLocaleString()} · 调用成功率 = 成功 / 总调用`

  if (magpie.onTheme) {
    magpie.onTheme(() => {})
  }
})()
