/**
 * jt-da-pa-memory 冒烟测试 —— 不依赖 dsh，直接跑核心逻辑。
 *   node test.mjs
 */
import assert from 'node:assert/strict'
import { remember, recall, forget, update, consolidate, undo, buildInjection, tokenize, memoryCommandDefinition, commandList } from './index.js'

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
  assert.equal(s.memories.length, 2); ok('近重复合并（复数词干化）')
  assert.ok(a.item.id.startsWith('pm_')); ok('id 格式 pm_xxxxxxxx')
}

// --- 召回：相关性 ---
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

// --- 召回：CJK bigram ---
{
  const s = fresh()
  remember(s, { text: '房东是 Bob Li', category: 'contact' })
  remember(s, { text: '喜欢喝咖啡', category: 'preference' })
  const hits = recall(s, '写邮件给房东').map((m) => m.text)
  assert.deepEqual(hits, ['房东是 Bob Li']); ok('中文 bigram 命中（写邮件给房东 → 房东是 Bob）')
}

// --- 召回：无 query 时按重要性 + 新鲜度 ---
{
  const s = fresh()
  remember(s, { text: 'low', importance: 1 })
  remember(s, { text: 'high', importance: 5 })
  const hits = recall(s, '', { limit: 1 }).map((m) => m.text)
  assert.deepEqual(hits, ['high']); ok('无 query 时高重要性优先')
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
  // 直接构造：两条相似但低于写入合并阈值（0.82）、高于整理阈值（0.72）
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
  assert.ok(buildInjection(s).includes('还是空的')); ok('空库注入提示（中文）')
  remember(s, { text: 'Lives in Beijing', category: 'identity', importance: 5 })
  const block = buildInjection(s)
  assert.ok(block.includes('你的个人记忆')); ok('注入标题为中文')
  assert.ok(block.includes('Lives in Beijing')); ok('注入包含核心记忆')
  assert.ok(block.includes('memory_recall')); ok('注入包含工具使用提示')
}

// --- replaces：事实变化时更新旧条目而非新增 ---
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
  assert.ok(t.includes('flight')); ok('分词含复数词干 flight')
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

console.log(`\n${pass} passed`)