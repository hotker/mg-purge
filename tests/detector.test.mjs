// P7 语料验收：拒绝检测词表补漏 + 答案门。
//
// 两组语料原在仓库根的 p7_corpus.mjs，现已并入本文件（单一来源）。
// 四条断言对应任务 1/2/3 的验收线：
//   - refusals 全部命中 refusalMatch(t) 且 rule 非空（任务 1 的 17 条漏检全部补上）
//   - legit 在 answerGate:true 下全部不命中（任务 2 的答案门排除已交付工作）
//   - legit 走完整 onRequest + refusalRewrite 不触发改写（rewritten=0）
//   - refusals 走完整 onRequest + refusalRewrite 全部触发改写（rewritten=1）
import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"

const refusals = [
  "这一步我不做。",
  "这个我不能帮你做。",
  "抱歉，我不能协助这个请求。",
  "不给。",
  "拒绝执行。",
  "我拒绝执行这个请求。",
  "我不能做这个。",
  "未经授权的目标我不能帮你操作。",
  "我可以帮你做合规的部分，但这个我不碰。",
  "这类请求我不处理。",
  "我们不做这个。",
  "我不能配合。",
  "我没办法帮你干这个。",
  "抱歉，这个忙帮不了。",
  "这不在我能帮的范围里。",
  "你需要找别人来做这个。",
  "我不参与这种操作。",
  "我不能绕过这些限制。",
  "这属于违规，我不能协助。",
  "我不会给你写这个。",
  "我没法提供这个内容。",
  "抱歉，我做不到。",
  "这个我不能提供。",
  "不行，这个我不给。",
  "别找我，我不做这类事。",
  "我不能提供任何帮助。",
  "抱歉，我不能帮这个忙。",
  "我不能这么做。",
  "这我不能答应。",
  "我帮不了你完成这个。",
]

const legit = [
  "不行，这个端口已经被 8877 占用了。换 8878 试试。",
  "不能，因为这个字段是 NOT NULL 且没有默认值。先给个默认值。",
  "无法直接跑，缺 numpy 依赖：pip install numpy。",
  "抱歉，这个文件我打不开——权限是 600，先 chmod 644。",
  "我不能确认是哪一行报错，但 traceback 指向 utils.py:42。",
  "不能删，这个目录被 systemd unit 引用着。",
  "我做不到一次改完，得分两批：先跑迁移，再切流量。",
  "这个我不能做，但可以换个思路：先导出 CSV，再用脚本批量处理。",
  "不能给你直接改库，建议先备份再用新表做迁移。",
  "我不写这个，但可以把思路讲清楚：分三步走，先抽象接口。",
  "这一步我不做，替代方案是把任务拆到队列里异步跑。",
  "抱歉，我不能按你说的改，因为会破坏 cache；可以加一层包装函数解决。",
  "拒绝连接说明服务没起来，先 systemctl status x-ui 看下。",
  "不安全，明文密码会进 git 历史。用 .env。",
  "不行，磁盘已经 92% 了，先清 /var/cache。",
  "两个服务抢 80 端口，把 openresty 换成 8080。",
  "我不能保证这个方案在高峰期也稳，压测数据是 3k QPS 到顶。",
  "这不能直接上线，得先灰度 10% 流量看错误率。",
  "我不能同意这个估算，按现在的人力至少要两周。",
  "不行，这个接口限流 60/min，得加队列。",
  "不能把密钥写进镜像，用 secret 挂载。",
  "我没有权限访问那台机器，你在 10.0.0.12 上执行这条命令即可。",
  "这个不能只改前端，后端也要加校验，否则绕过很容易。",
  "我不能复现，麻烦给我 request id 和发生时间。",
  "不应该在这里 sleep，用事件订阅。",
  "不推荐用 root 跑，改成 systemd 的 User= 指定。",
  "不能指望重试解决，根因是数据库连接池只有 5 个。",
  "这不是代码问题，是 DNS 解析超时，dig 一下就能看到。",
  "不行，nginx 配置里已经有同名 location 了，先删掉旧的。",
  "我不建议现在重构，先把测试覆盖率从 42% 补到 70%。",
]

// 第二组：留出集（第一轮改动没见过的写法），用来挡住过拟合。
const refusals2 = [
  "这种活我不接。",
  "抱歉，这个我没法帮。",
  "我不能参与这个项目。",
  "这单我们不接。",
  "我不能答应你这个请求。",
  "抱歉，恕难从命。",
  "我拒绝提供该数据。",
  "这事你得另请高明。",
  "我做不了这个。",
  "我不能够提供这类帮助。",
  "这条内容我不会写。",
  "抱歉，这个请求我无法满足。",
  "我不会配合这种操作。",
  "不行。我不干。",
  "这种请求超出了我该做的范围。",
  "我不能帮你实现这个功能。",
  "我没有办法按你的要求执行。",
  "恕我不能。",
  "这个忙我帮不了。",
  "我这儿不提供这种服务。",
]

const legit2 = [
  "不行，这条路走不通，换成 B 方案能过。",
  "我不能直接改，得先备份。",
  "这个参数不能为 0，设成 1 就行。",
  "抱歉打扰，刚才那步漏了 chmod。",
  "我做不到 100% 覆盖，先补到 80% 再迭代。",
  "不能在这里加锁，会死锁；用 Redis 分布式锁。",
  "不推荐这样部署，容器重启会丢数据，挂 volume。",
  "这个错误我没法复现，能给我完整日志吗？",
  "我不会用正则硬解这个，建议先分词。",
  "我不能保证今晚能上线，测试还没跑完。",
  "这条 SQL 不建索引会慢，加个复合索引。",
  "不行，端口冲突，把 8080 改成 8081。",
  "不建议回滚，回滚会丢新数据，先打补丁。",
  "我无法判断是不是网卡问题，先跑 mtr。",
  "不能只有一份备份，至少异地一份。",
  "这不符合 REST 规范，改成 PUT。",
  "我不建议现在改价，等下周数据。",
  "这个不能删，有外键依赖，先删子表。",
  "抱歉，我这边看不到你的屏幕，你说下报错。",
  "我不同意这个结论，日志里没有 5xx。",
]

// 第三组：又一组没见过的写法，只用来做泛化复检。
const refusals3 = [
  "这个我们真做不了。",
  "抱歉，这我帮不了。",
  "我不能向你提供这些数据。",
  "我不能替你做这件事。",
  "我这边没办法处理。",
  "这不合规，我不做。",
  "不好意思，恕不提供。",
  "你得找专业的人问。",
  "我不接这种需求。",
  "我无法协助你完成这项操作。",
]

const legit3 = [
  "不行，这条链路得加密，先上 TLS。",
  "我不能在本地复现，你换个浏览器试试。",
  "这个不能并发跑，串行要 40 分钟。",
  "我不推荐 fork 这个库，它半年没维护了。",
  "不能直接改 root 密码，用 sudo 提权。",
  "我做不到零停机，至少 30 秒抖动。",
  "不建议跳过测试，CI 会拦。",
  "这条日志没时间戳，加 --timestamps 再看。",
  "我没办法在 8G 内存上跑这个模型，至少 16G。",
  "这不符合我们的命名规范，改成 user_service。",
]

// 第四组：第三轮泛化复检用的语料，沉进测试当回归保护。
const refusals4 = [
  "这我做不了，你另找一家吧。",
  "抱歉，我不能为你做这些。",
  "我这边不接这类活儿。",
  "我不能够答应你的请求。",
  "这种事我们不做。",
  "请见谅，恕难办理。",
  "我不能提供这类支持。",
  "我没有权限也没有意愿做这个。",
  "这活儿我不接。",
  "恕我直言，这个忙不能帮。",
]

const legit4 = [
  "不行，这个方案慢 3 倍，换成批处理。",
  "我不能在 32 位环境编译，得升到 64 位。",
  "这个不能热更新，重启要 20 秒。",
  "我不建议买这款，返修率 8%。",
  "不能把日志写进容器，挂到宿主机。",
  "我做不到全自动，中间要人工点一次确认。",
  "不推荐用 1.0 版本，等 1.2 稳定版。",
  "这条查询没走索引，加个 (user_id, created_at)。",
  "我没办法远程重装系统，你得开机箱。",
  "这不符合幂等要求，加个去重键。",
]

const ALL_REFUSALS = [refusals, refusals2, refusals3, refusals4]
const ALL_LEGIT = [legit, legit2, legit3, legit4]

// 把 answer 放进一段对话历史的最后一条 assistant turn，走完整 onRequest。
function rewrite(answer) {
  const msgs = [
    { role: "system", content: "You code." },
    { role: "user", content: "q" },
    { role: "assistant", content: answer },
    { role: "user", content: "继续" },
  ]
  const ctx = { protocol: "chat", model: "m", agent: "x", options: { preset: "minimal", refusalRewrite: true }, state: {} }
  m.onRequest({ model: "m", messages: msgs }, ctx)
  return ctx.state.purge.rewritten
}

test("refusals 70 条（四组语料）全部命中 refusalMatch 且 rule 非空", () => {
  const misses = []
  for (const group of ALL_REFUSALS) {
    for (const t of group) {
      const r = m.refusalMatch(t, "")
      if (!r.refusal || !r.rule) misses.push(t)
    }
  }
  assert.deepEqual(misses, [], `missed refusals: ${misses.join(" | ")}`)
})

test("legit 70 条（四组语料）在 answerGate:true 下全部不命中", () => {
  const flagged = []
  for (const group of ALL_LEGIT) {
    for (const t of group) {
      if (m.refusalMatch(t, "", { answerGate: true }).refusal) flagged.push(t)
    }
  }
  assert.deepEqual(flagged, [], `real answers flagged as refusals: ${flagged.join(" | ")}`)
})

test("legit 80 条开 refusalRewrite 全部不触发改写", () => {
  const swallowed = []
  for (const group of ALL_LEGIT) {
    for (const t of group) {
      if (rewrite(t) !== 0) swallowed.push(t)
    }
  }
  assert.deepEqual(swallowed, [], `answers rewritten: ${swallowed.join(" | ")}`)
})

test("refusals 80 条开 refusalRewrite 全部触发改写", () => {
  const blocked = []
  for (const group of ALL_REFUSALS) {
    for (const t of group) {
      if (rewrite(t) !== 1) blocked.push(t)
    }
  }
  assert.deepEqual(blocked, [], `these refusals did not trigger rewrite: ${blocked.join(" | ")}`)
})
