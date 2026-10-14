/**
 * jt-da-pa-memory 冒烟测试 —— 不依赖 dsh，直接跑核心逻辑。
 *   node test.mjs
 */
import assert from 'node:assert/strict'
import { remember, recall, forget, update, consolidate, undo, buildInjection, tokenize, memoryCommandDefinition, commandList, dream, archiveStale, profileOf, resolveConfig, profileCommandDefinition, commandProfile, exportMarkdown, apply as applyPlugin } from './index.js'

const fresh = () => ({ version: 1, memories: [], log: [], updatedAt: 0 })
let pass = 0
const ok = (name) => { pass++; console.log(`  ✓ ${name}`) }

console.log('jt-da-pa-memory tests')

// --- 写入与去重 ---
{
  const s = fresh()
  const a = remember(s, { text: 'Prefers window seats on flights', category: 'preference', importance: 3 })
  remember(s, { text: 'Lives in Beijing', category: 'identity', importance: 5 })
  assert.equal(s.memories.length, 2); ok('写入两条')

  const dup = remember(s, { text: 'lives in beijing', category: 'identity' })
  assert.equal(dup.deduped, true)
  assert.equal(s.memories.length, 2); ok('大小写精确去重')

  const near = remember(s, { text: 'Prefers a window seat on flights', category: 'preference' })
  assert.equal(near.merged, true)
  assert.equal(s.memories.length, 2); ok('近重合并 (复数词干化) ')
  assert.ok(a.item.id.startsWith('pm_')); ok('id 格式 pm_xxxxxxxx')
}

// --- 召回: 相关性 ---
{
  const s = fresh()
  remember(s, { text: 'Prefers window seats on flights', category: 'preference' })
  remember(s, { text: 'Lives in Beijing', category: 'identity', importance: 5 })
  remember(s, { text: 'Partner is vegetarian', category: 'contact' })
  const hits = recall(s, 'book me a window seat for the flight to Beijing').map((m) => m.text)
  assert.ok(hits[0].includes('window')); ok('相关记忆排第一')
  assert.ok(hits.includes('Lives in Beijing')); ok('query 里的 Beijing 也命中')
  assert.ok(!hits.includes('Partner is vegetarian')); ok('无关记忆不召回')
}

// --- 召回: CJK bigram ---
{
  const s = fresh()
  remember(s, { text: '房东是 Bob Li', category: 'contact' })
  remember(s, { text: '喜欢喝咖啡', category: 'preference' })
  const hits = recall(s, '写邮件给房东').map((m) => m.text)
  assert.deepEqual(hits, ['房东是 Bob Li']); ok('中文 bigram 命中 (写邮件给房东 → 房东是 Bob)')
}

// --- 召回: 无 query 时按重要性 + 新鲜度 ---
{
  const s = fresh()
  remember(s, { text: 'low', importance: 1 })
  remember(s, { text: 'high', importance: 5 })
  const hits = recall(s, '', { limit: 1 }).map((m) => m.text)
  assert.deepEqual(hits, ['high']); ok('无 query 时重要性优先')
}

// --- project 作用域 ---
{
  const s = fresh()
  remember(s, { text: 'global pref', category: 'preference' })
  remember(s, { text: 'dsh-only note', category: 'project', project: 'dsh' })
  remember(s, { text: 'femo-only note', category: 'project', project: 'femo' })
  const inDsh = recall(s, '', { project: 'dsh' }).map((m) => m.text)
  assert.ok(inDsh.includes('global pref')); ok('project 召回包含全局')
  assert.ok(inDsh.includes('dsh-only note'))
  assert.ok(!inDsh.includes('femo-only note')); ok('project 召回排除其他项目')
}

// --- 更新 / 遗忘 / 撤销 ---
{
  const s = fresh()
  const a = remember(s, { text: 'Works at Acme', category: 'fact', importance: 2 })
  const up = update(s, { id: a.item.id, text: 'Works at Globex', importance: 4 })
  assert.equal(up.text, 'Works at Globex'); ok('更新记忆')

  forget(s, { query: 'Globex' })
  assert.equal(s.memories.length, 0); ok('按 query 遗忘')
  undo(s)
  assert.equal(s.memories.length, 1); ok('撤销遗忘（可逆）')
  assert.equal(s.memories[0].text, 'Works at Globex'); ok('撤销恢复的是更新后的内容')
}

// --- 整理不发明事实、不删空之外的东西 ---
{
  const s = fresh()
  const now = Date.now()
  // 直接构造：两条相似但低于写入合并阈值 (0.82)、高于整理阈值 (0.72)
  s.memories = [
    { id: 'pm_a', text: 'prefers window seat', category: 'preference', importance: 3, createdAt: now, updatedAt: now },
    { id: 'pm_b', text: 'prefers a window seat please', category: 'preference', importance: 2, createdAt: now, updatedAt: now },
    { id: 'pm_c', text: 'unique fact about a cat', category: 'fact', importance: 3, createdAt: now, updatedAt: now },
  ]
  const r = consolidate(s)
  assert.equal(r.merged, 1); ok('整理合并近重复')
  assert.equal(r.total, 2); ok('整理后总数正确')
  assert.ok(s.memories.some((m) => m.text.includes('cat'))); ok('整理不误删不同主题')
}

// --- 注入渲染 ---
{
  const s = fresh()
  assert.ok(buildInjection(s).includes('还是空的')); ok('空库注入提示 (中文) ')
  remember(s, { text: 'Lives in Beijing', category: 'identity', importance: 5 })
  const block = buildInjection(s)
  assert.ok(block.includes('你的个人记忆')); ok('注入标题为中文')
  assert.ok(block.includes('Lives in Beijing')); ok('注入包含核心记忆')
  assert.ok(block.includes('memory_recall')); ok('注入包含工具使用提示')
}

// --- replaces: 事实变化时更新旧条目而非新增 ---
{
  const s = fresh()
  const a = remember(s, { text: '在上海工作', category: 'fact' })
  const r = remember(s, { text: '在北京工作', category: 'fact', replaces: a.item.id })
  assert.equal(s.memories.length, 1); ok('replaces 不新增条目')
  assert.equal(r.item.id, a.item.id); ok('replaces 保留原 id')
  assert.equal(s.memories[0].text, '在北京工作'); ok('replaces 更新了内容')
}

// --- 分词 ---
{
  const t = [...tokenize('写邮件给房东 book flights')]
  assert.ok(t.includes('房东')); ok('分词含 CJK bigram 房东')
  assert.ok(t.includes('flight')); ok('分词含复词词干 flight')
}

// --- /memory 命令 ---
{
  const s = fresh()
  remember(s, { text: '坐飞机喜欢靠窗', category: 'preference', importance: 3 })
  remember(s, { text: '在北京工作', category: 'identity', importance: 5 })
  const cmd = memoryCommandDefinition(s, () => {})
  const run = (raw) => cmd.handler({ rawInput: raw })

  assert.equal(cmd.name, 'memory'); ok('/memory 命令名为 memory')
  const listed = run('')
  assert.equal(listed.kind, 'success')
  assert.ok(listed.text.includes('坐飞机喜欢靠窗')); ok('/memory 列出记忆内容')
  assert.ok(listed.text.includes('[pm_')); ok('/memory 显示记忆 id')

  const f = run('forget 靠窗')
  assert.equal(f.kind, 'success'); ok('/memory forget <文字> 删除')
  assert.equal(s.memories.length, 1)

  const u = run('undo')
  assert.equal(u.kind, 'success'); ok('/memory undo 撤销')
  assert.equal(s.memories.length, 2)

  const byId = run('forget id:' + s.memories[0].id)
  assert.equal(byId.kind, 'success'); ok('/memory forget id:<id> 删除')
  assert.equal(s.memories.length, 1)

  const bad = run('nope')
  assert.equal(bad.kind, 'error'); ok('/memory 未知子命令报错')
  assert.ok(run('help').text.includes('/memory')); ok('/memory help 显示帮助')
  assert.ok(commandList(fresh()).includes('还是空的')); ok('空库 /memory 提示中文')
}

// --- 个性化：关于你 (身份 + 偏好) ---
{
  const s = fresh()
  remember(s, { text: '名字叫小蓝', category: 'identity', importance: 5 })
  remember(s, { text: '喜欢简短的回答', category: 'preference', importance: 4 })
  remember(s, { text: '在北京工作', category: 'fact', importance: 2 })
  const p = profileOf(s)
  assert.equal(p.identity.length, 1); ok('画像含身份')
  assert.equal(p.preference.length, 1); ok('画像含偏好')
  const block = buildInjection(s)
  assert.ok(block.includes('### 关于你')); ok('注入含【关于你】画像段')
  assert.ok(block.indexOf('名字叫小蓝') < block.indexOf('在北京工作')); ok('身份排在事实前面')
}

// --- /profile 命令 ---
{
  const s = fresh()
  remember(s, { text: '名字叫小蓝', category: 'identity', importance: 5 })
  remember(s, { text: '喜欢简短的回答', category: 'preference', importance: 4 })
  const prof = profileCommandDefinition(s, () => {}).handler({})
  assert.equal(prof.kind, 'success'); ok('/profile 返回成功')
  assert.ok(prof.text.includes('关于你')); ok('/profile 标题')
  assert.ok(prof.text.includes('名字叫小蓝')); ok('/profile 含身份')
  assert.ok(prof.text.includes('喜欢简短的回答')); ok('/profile 含偏好')
  assert.ok(commandProfile(fresh()).includes('还没有形成')); ok('空画像提示')
  const viaMemory = memoryCommandDefinition(s, () => {}, {}).handler({ rawInput: 'profile' })
  assert.ok(viaMemory.text.includes('名字叫小蓝')); ok('/memory profile 也能看画像')
}

// --- dream: 整理 + 归档 ---
{
  const s = fresh()
  remember(s, { text: 'prefers window seat', category: 'preference', importance: 3 })
  remember(s, { text: 'prefers a window seat please', category: 'preference', importance: 2 })
  // 一条陈旧、低价值、从未访问的记忆 (应被归档)
  const old = remember(s, { text: '问了京都的天气', category: 'other', importance: 1 }).item
  old.createdAt = old.updatedAt = Date.now() - 200 * 86400000
  const cfg = resolveConfig({ dream: { idleMinutes: 30, archiveAfterDays: 120 } })
  const r = dream(s, cfg)
  assert.ok(r.merged >= 0); ok('dream 合并近重复')
  assert.equal(r.archived, 1); ok('dream 归档陈旧低价值条目')
  assert.equal(s.lastDreamAt > 0, true); ok('dream 记录时间戳')
  // 归档可撤销
  const totalLive = s.memories.filter((m) => !m.archived).length
  undo(s)
  assert.ok(s.memories.filter((m) => !m.archived).length >= totalLive); ok('归档可撤销')
}

// --- archiveStale: 高价值不归档 ---
{
  const s = fresh()
  const a = remember(s, { text: '重要的身份', category: 'identity', importance: 5 }).item
  a.createdAt = a.updatedAt = Date.now() - 400 * 86400000
  const b = remember(s, { text: '不重要的旧事', category: 'other', importance: 1 }).item
  b.createdAt = b.updatedAt = Date.now() - 400 * 86400000
  const r = archiveStale(s, 120)
  assert.equal(r.archived, 1); ok('只归档低价值条目')
  assert.equal(s.memories.find((m) => m.id === a.id).archived || false, false); ok('高价值条目不被归档')
}

// --- 主动打扰：memory_remind 经 ctx.schedule ---
{
  const s = fresh()
  const created = []
  const ctx = {
    logger: {},
    tools: { register: (d) => { ctx._defs.push(d); return () => {} } },
    effect: (f) => { f(); return () => {} },
    inject: (deps, cb) => {
      if (deps[0] === 'schedule') cb({ schedule: {
        create: async (sessionId, req) => { created.push({ sessionId, req }); return { id: 'sch_1', title: req.title } },
        list: async () => [{ id: 'sch_1', title: '喝水' }],
        delete: async () => ({}),
      } })
      if (deps[0] === 'systemPrompt') cb({ systemPrompt: { context: () => () => {} } })
      if (deps[0] === 'commands') cb({ commands: { register: () => () => {} } })
    },
    _defs: [],
  }
  applyPlugin(ctx, { dream: { enabled: false } })
  assert.equal(ctx._defs.length, 11); ok('注册了 11 个工具 (含新增 4 个) ')
  const remind = ctx._defs.find((d) => d.name === 'memory_remind')
  const exec = { agent: { session: { id: 'sess_1' } }, signal: { aborted: false } }
  const r = await remind.execute({ text: '该喝水了', after_seconds: 600 }, exec)
  assert.equal(r.ok, true); ok('memory_remind 安排成功')
  assert.equal(created[0].sessionId, 'sess_1'); ok('提醒绑定到当前会话')
  assert.equal(created[0].req.prompt, '该喝水了'); ok('提醒内容正确')
  assert.equal(created[0].req.after_seconds, 600); ok('时间选择器传递')
  assert.ok(created[0].req.title.startsWith('主动·')); ok('提醒标题带「主动·」前缀 (可辨识) ')
  const bad = await remind.execute({ text: '没时间' }, exec)
  assert.equal(bad.ok, false); ok('缺少时间时报错')
  const list = ctx._defs.find((d) => d.name === 'memory_reminders')
  assert.equal((await list.execute({}, exec))[0].id, 'sch_1'); ok('memory_reminders 列出')
}

// --- 无定时服务时主动打扰优雅降级 ---
{
  const s = fresh()
  const ctx = {
    logger: {}, tools: { register: (d) => { ctx._defs.push(d); return () => {} } }, effect: (f) => { f(); return () => {} },
    inject: (deps, cb) => { if (deps[0] === 'systemPrompt') cb({ systemPrompt: { context: () => () => {} } }) },
    _defs: [],
  }
  applyPlugin(ctx, { dream: { enabled: false } })
  const remind = ctx._defs.find((d) => d.name === 'memory_remind')
  const r = await remind.execute({ text: 'x', after_seconds: 60 }, { agent: { session: { id: 's' } } })
  assert.equal(r.ok, false); ok('无 dsh-schedule 时返回明确错误')
  assert.ok(r.error.includes('定时服务')); ok('错误信息说明原因')
}



// ===========================================================================
// 回归测试：10 项隐藏 Bug 修复 + v0.3.0 创新特性验证
// ===========================================================================

// --- 回归 1: dream() 返回的 total 准确扣除新归档条目，且单次 undo 完整恢复整次 dream ---
{
  const s = fresh()
  remember(s, { text: 'prefers window seat', category: 'preference', importance: 3 })
  remember(s, { text: 'prefers a window seat please', category: 'preference', importance: 2 })
  const old1 = remember(s, { text: '临时测试条目甲', category: 'other', importance: 1 }).item
  const old2 = remember(s, { text: '临时测试条目乙', category: 'other', importance: 1 }).item
  old1.createdAt = old1.updatedAt = Date.now() - 200 * 86400000
  old2.createdAt = old2.updatedAt = Date.now() - 200 * 86400000
  const cfg = resolveConfig({ dream: { idleMinutes: 30, archiveAfterDays: 120 } })
  const r = dream(s, cfg)
  const actualLive = s.memories.filter((m) => !m.archived).length
  assert.equal(r.total, actualLive); ok('[Bug1修复] dream 返回的 total 准确等于归档后的活跃记忆数')
  undo(s)
  assert.equal(s.memories.filter((m) => !m.archived).length, 4); ok('[Bug2修复] 单次 undo 即可完整恢复整次 dream 的多次合并与归档')
}

// --- 回归 2: 已归档记忆再次 remember 时自动唤醒 (不再幽灵拦截) ---
{
  const s = fresh()
  const item = remember(s, { text: '喜欢喝冰美式', category: 'preference', importance: 1 }).item
  item.createdAt = item.updatedAt = Date.now() - 200 * 86400000
  archiveStale(s, 120)
  assert.equal(recall(s, '美式').length, 0)
  remember(s, { text: '喜欢喝冰美式', category: 'preference', importance: 4 })
  assert.equal(recall(s, '美式').length, 1); ok('[Bug6修复] 重新记住已归档记忆时自动取消归档并恢复可召回状态')
}

// --- 回归 3: remember 新增条目支持 undo 撤销 ---
{
  const s = fresh()
  remember(s, { text: '第一条正确记忆', category: 'fact' })
  remember(s, { text: '误录入的错误记忆', category: 'fact' })
  assert.equal(s.memories.length, 2)
  const u = undo(s)
  assert.equal(u.undone, true)
  assert.equal(u.action, 'remember')
  assert.equal(s.memories.length, 1)
  assert.equal(s.memories[0].text, '第一条正确记忆'); ok('[Bug7修复] remember 新增记忆支持 undo 撤销')
}

// --- 回归 4: buildInjection 保证高优 preference 不被多条 identity 完全挤出 ---
{
  const s = fresh()
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo']
  for (const w of words) {
    remember(s, { text: `Identity trait ${w} unique_${w}`, category: 'identity', importance: 3 })
  }
  remember(s, { text: '超级核心偏好：绝对不要用 emoji', category: 'preference', importance: 5 })
  const inj = buildInjection(s)
  assert.ok(inj.includes('绝对不要用 emoji')); ok('[Bug8修复] 高优先级偏好不会被超过10条的 identity 完全挤出注入上下文')
}

// --- 回归 5: tokenize 不再跨标点伪造 CJK bigram，且保留单数字与常见带 s 词汇 ---
{
  const t = tokenize('我在北京，喜欢喝茶 住在 3 楼 使用 nodejs 和 cities')
  assert.ok(!t.has('京喜')); ok('[Bug9修复] CJK 分词不跨标点伪造 bigram (无「京喜」)')
  assert.ok(t.has('3')); ok('[Bug9修复] 保留单数字 token (3)')
  assert.ok(t.has('nodejs')); ok('[Bug9修复] nodejs 不被误切为 nodej')
  assert.ok(t.has('city')); ok('[Bug9修复] cities 正确词干化为 city')
}

// --- 回归 6: JSON Schema 严格合规 + every_seconds 与 proactive.enabled 生效 ---
{
  const ctx = {
    logger: {}, tools: { register: (d) => { ctx._defs.push(d); return () => {} } }, effect: (f) => { f(); return () => {} },
    inject: (deps, cb) => {
      if (deps[0] === 'schedule') cb({ schedule: { create: async (sid, req) => ({ id: 'sch_2', title: req.title }) } })
    },
    _defs: [],
  }
  applyPlugin(ctx, { dream: { enabled: false }, proactive: { enabled: false } })
  for (const d of ctx._defs) {
    for (const [, prop] of Object.entries(d.parameters.properties || {})) {
      assert.equal(typeof prop.required, 'undefined')
    }
  }
  ok('[Bug3修复] 所有工具 JSON Schema 属性内部不再包含非法 boolean required')
  const remindDisabled = ctx._defs.find((d) => d.name === 'memory_remind')
  const rDisabled = await remindDisabled.execute({ text: '喝水', every_seconds: 300 }, { agent: { session: { id: 's1' } } })
  assert.equal(rDisabled.ok, false)
  assert.ok(rDisabled.error.includes('禁用')); ok('[Bug5修复] proactive.enabled=false 时拒绝创建主动打扰')
}

// --- 创新特性 1: 双时态事实演化链 (Bi-Temporal History) ---
{
  const s = fresh()
  const a = remember(s, { text: '目前在上海担任后端工程师', category: 'identity', importance: 5 })
  const b = remember(s, { text: '目前在北京担任 AI Agent 架构师', category: 'identity', importance: 5, replaces: a.item.id })
  assert.equal(b.item.history.length, 1); ok('[创新1] replaces 自动记录事实历史演化轨迹')
  assert.equal(b.item.history[0].text, '目前在上海担任后端工程师')
  const inj = buildInjection(s)
  assert.ok(inj.includes('曾: 目前在上海担任后端工程师')); ok('[创新1] 注入上下文携带「曾:...」演化轨迹')
}

// --- 创新特性 2: 阶段性情境记忆 (Episodic TTL expires_in_days) ---
{
  const s = fresh()
  const ep = remember(s, { text: '本周在京都出差参加会议', category: 'fact', importance: 4, expires_in_days: 7 }).item
  assert.ok(ep.expiresAt > Date.now()); ok('[创新2] expires_in_days 自动计算到期时间戳')
  assert.equal(recall(s, '京都').length, 1); ok('[创新2] 未到期情境记忆可正常召回')
  ep.expiresAt = Date.now() - 1000
  assert.equal(recall(s, '京都').length, 0); ok('[创新2] 已到期情境记忆自动对召回与注入隐身')
  const ar = archiveStale(s, 120)
  assert.equal(ar.archived, 1); ok('[创新2] 已到期情境记忆在 archiveStale 时直接归档 (无需等待 120 天)')
}

// --- 创新特性 3: 避坑准则专席 (Lessons) + 同类别语义冲突预警 (Conflict Guard) ---
{
  const s = fresh()
  remember(s, { text: '代码注释一律使用中文，禁止输出多余空谈', category: 'lesson', importance: 4 })
  const inj = buildInjection(s)
  assert.ok(inj.includes('### 经验与避坑准则')); ok('[创新3] lesson 类别独立高优注入「经验与避坑准则」段落')

  remember(s, { text: '喝咖啡只喝冰美式不加糖', category: 'preference', importance: 3 })
  const conflictCheck = remember(s, { text: '喝咖啡喜欢热拿铁加全脂奶', category: 'preference', importance: 3 })
  assert.equal(conflictCheck.merged, false)
  assert.ok(conflictCheck.related.length >= 1); ok('[创新4] 同类别中等相似度记忆自动触发 related 冲突/关联提醒')
}

// --- 创新特性 4: Markdown 档案导出 (/memory export) ---
{
  const s = fresh()
  remember(s, { text: '名字叫小蓝', category: 'identity', importance: 5 })
  remember(s, { text: '偏爱函数式编程风格', category: 'preference', importance: 4 })
  const md = exportMarkdown(s)
  assert.ok(md.includes('# 个人记忆档案')); ok('[创新5] exportMarkdown 导出结构化 Markdown 档案')
  const viaCmd = memoryCommandDefinition(s, () => {}, {}).handler({ rawInput: 'export' })
  assert.equal(viaCmd.kind, 'success')
  assert.ok(viaCmd.text.includes('名字叫小蓝')); ok('[创新5] /memory export 命令正常输出')
}

console.log(`\n${pass} passed`)