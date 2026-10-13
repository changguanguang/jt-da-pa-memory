/**
 * jt-da-pa-memory — 一个「个人 AI」风格的跨会话记忆插件（DeepSeek Harness）。
 *
 * 设计信条（personal AI 的特征）：
 *   1. 记住「你这个人」——身份 / 偏好 / 长期事实，而不是聊天记录。
 *   2. 可读可改——记忆是普通 JSON 文件，你可以直接编辑。
 *   3. 每条记忆带出处（谁写的、何时、属于哪个项目）。
 *   4. 相关性 + 重要性 + 时间衰减 三层打分，只把「够格的」喂给模型。
 *   5. 遗忘可见且可撤销——每次删除/合并都记日志，可 undo。
 *   6. 整理（consolidate）合并近重复、删除空条目，且只做「代码能判断」的事。
 *
 * 实现方式：完全对齐 dsh 官方模式「section provider + tool」——
 *   · 写入/检索：ctx.tools.register() 注册 memory_* 工具
 *   · 注入：ctx.systemPrompt.context() 注册动态上下文（满足 Model-visible ⟺ logged）
 *   · 存储：插件自有的 JSON 文件（不写进 session log）
 *
 * 零运行时依赖：只用 node 内置模块，import 不涉及任何 dsh 包，
 * 因此不受 dsh 版本 API 漂移影响。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['identity', 'preference', 'fact', 'project', 'lesson', 'goal', 'other']
const MAX_MEMORIES = 500
const MAX_TEXT = 400
const MERGE_SIMILARITY = 0.82
const CORE_IMPORTANCE = 3          // importance ≥ 3 视为「核心」，每轮必注入
const INJECT_CORE_MAX = 12         // 核心块最多注几条
const INJECT_RECENT_MAX = 6        // 最近记忆最多注几条
const HALF_LIFE_DAYS = 45          // 时间衰减半衰期

// ─────────────────────────────────────────────────────────────────────────────
// 存储：$DSH_HOME/jt-da-pa-memory/memory.json
// ─────────────────────────────────────────────────────────────────────────────

function dshHome() {
  const home = process.env.DSH_HOME
  if (home && home.trim()) return home
  return join(homedir(), '.dsh')
}

function storePath(config) {
  const dir = config?.dir || join(dshHome(), 'jt-da-pa-memory')
  return join(dir, 'memory.json')
}

function emptyStore() {
  return { version: 1, memories: [], log: [], updatedAt: 0 }
}

function loadStore(file) {
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.memories)) {
        return { version: 1, memories: raw.memories, log: raw.log || [], updatedAt: raw.updatedAt || 0 }
      }
    }
  } catch {
    // 文件损坏：不阻塞启动，从空库开始（旧文件改名留底）
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
  }
  return emptyStore()
}

function saveStore(file, store) {
  store.updatedAt = Date.now()
  const tmp = `${file}.tmp-${process.pid}`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
}

// ─────────────────────────────────────────────────────────────────────────────
// 分词与打分
// ─────────────────────────────────────────────────────────────────────────────

const WORD_RE = /[^\W_\u3400-\u9fff]+/g        // 任意文字（字母/数字），排除 CJK
const CJK_RE = /[\u3400-\u9fff]/g              // 汉字

/** 分词：字母词（小写，去复数 s）+ CJK 相邻 2-gram。和 nanoMuse 的 tokenize 同思路。 */
export function tokenize(text) {
  const out = new Set()
  for (const w of String(text || '').toLowerCase().match(WORD_RE) || []) {
    if (w.length <= 1) continue
    // 极轻量词干化：去掉复数尾 s（不处理 ss），让 seats/seat、flights/flight 命中
    const t = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
    out.add(t)
  }
  const cjk = (String(text || '').match(CJK_RE) || []).join('')
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return out
}

function jaccard(a, b) {
  const ta = tokenize(a), tb = tokenize(b)
  if (!ta.size || !tb.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

function importanceWeight(importance) {
  const n = Math.max(1, Math.min(5, Number(importance) || 3))
  return 0.5 + n * 0.2            // 1→0.7, 3→1.1, 5→1.5
}

function recencyDecay(ts) {
  const days = Math.max(0, (Date.now() - (ts || 0)) / 86400000)
  return Math.pow(0.5, days / HALF_LIFE_DAYS)   // 45 天衰减到一半
}

/** IDF：越稀有的共享词权重越高。 */
function idfTable(memories) {
  const df = new Map()
  for (const m of memories) {
    for (const t of tokenize(m.text)) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = Math.max(1, memories.length)
  const out = new Map()
  for (const [t, c] of df) out.set(t, Math.log((n + 1) / c))
  return out
}

function projectMatches(mem, project) {
  if (!project) return true
  const p = String(mem.project || '').trim()
  return p === '' || p === project
}

/** 对一个 query 给一条记忆打分。 */
function scoreMem(mem, qTokens, idf) {
  const tokens = tokenize(mem.text)
  let s = 0
  for (const t of qTokens) if (tokens.has(t)) s += idf.get(t) ?? Math.log(2)
  return s * importanceWeight(mem.importance) * recencyDecay(mem.updatedAt || mem.createdAt)
}

// ─────────────────────────────────────────────────────────────────────────────
// 记忆操作
// ─────────────────────────────────────────────────────────────────────────────

function newId() { return 'pm_' + randomBytes(4).toString('hex') }

function pushLog(store, action, before, after, reason) {
  store.log.push({ at: Date.now(), action, before, after: after || null, reason: reason || '' })
  if (store.log.length > 200) store.log.splice(0, store.log.length - 200)
}

/** 写入；完全相同 / 高度相似则合并，返回 { item, merged }。 */
export function remember(store, input) {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!text) throw new Error('memory text is empty')
  const category = CATEGORIES.includes(input.category) ? input.category : 'other'
  const project = String(input.project || '').trim()
  const importance = Math.max(1, Math.min(5, Number(input.importance) || 3))
  const now = Date.now()

  const exact = store.memories.find((m) => m.text.toLowerCase() === text.toLowerCase())
  if (exact) return { item: exact, merged: false, deduped: true }

  // 显式替换：事实变了，用 replaces 指向旧条目（而不是新增第二条）
  if (input.replaces) {
    const target = store.memories.find((m) => m.id === input.replaces)
    if (target) {
      const b = { ...target }
      target.text = text
      if (input.category) target.category = category
      target.importance = Math.max(target.importance, importance)
      target.updatedAt = now
      pushLog(store, 'update', [b], { ...target }, `replaces ${input.replaces}`)
      return { item: target, merged: true, deduped: false }
    }
  }

  // 近重复：同一 category + 同 project，相似度够高 → 更新旧条目
  let best = null, bestScore = 0
  for (const m of store.memories) {
    if (m.category !== category) continue
    if ((m.project || '') !== project) continue
    const sim = jaccard(m.text, text)
    if (sim > bestScore) { bestScore = sim; best = m }
  }
  if (best && bestScore >= MERGE_SIMILARITY) {
    const before = { ...best }
    best.text = text
    best.importance = Math.max(best.importance, importance)
    best.updatedAt = now
    pushLog(store, 'merge', [before], { ...best }, `similarity ${bestScore.toFixed(2)}`)
    return { item: best, merged: true, deduped: false }
  }

  const item = {
    id: newId(), text, category, project, importance,
    source: input.source || { kind: 'agent' },
    createdAt: now, updatedAt: now, accessCount: 0, lastAccessedAt: 0,
  }
  store.memories.push(item)
  if (store.memories.length > MAX_MEMORIES) store.memories.splice(0, store.memories.length - MAX_MEMORIES)
  return { item, merged: false, deduped: false }
}

export function recall(store, query, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 8))
  const project = opts.project || ''
  const category = opts.category || ''
  const pool = store.memories.filter((m) =>
    !m.archived && projectMatches(m, project) && (!category || m.category === category))
  if (pool.length === 0) return []
  const idf = idfTable(pool)
  const qTokens = tokenize(query || '')
  if (qTokens.size === 0) {
    // 没有 query：按重要性 + 新鲜度取
    return [...pool]
      .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
      .slice(0, limit)
  }
  const scored = pool
    .map((m) => ({ m, s: scoreMem(m, qTokens, idf) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.m)
}

export function forget(store, { id, query }) {
  if (id) {
    const i = store.memories.findIndex((m) => m.id === id)
    if (i < 0) return { removed: 0 }
    const [item] = store.memories.splice(i, 1)
    pushLog(store, 'forget', [item], null, `id ${id}`)
    return { removed: 1 }
  }
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { removed: 0 }
  const hit = store.memories.filter((m) => m.text.toLowerCase().includes(q))
  if (hit.length === 0) return { removed: 0 }
  store.memories = store.memories.filter((m) => !hit.includes(m))
  pushLog(store, 'forget', hit, null, `matched "${query}"`)
  return { removed: hit.length }
}

export function update(store, { id, text, importance, category, project }) {
  const item = store.memories.find((m) => m.id === id)
  if (!item) return null
  const before = { ...item }
  if (text) item.text = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (importance != null) item.importance = Math.max(1, Math.min(5, Number(importance) || item.importance))
  if (category && CATEGORIES.includes(category)) item.category = category
  if (project != null) item.project = String(project).trim()
  item.updatedAt = Date.now()
  pushLog(store, 'update', [before], { ...item }, '')
  return item
}

/** 整理：合并近重复 + 删除空条目。只做「代码能确定判断」的事，不发明事实。 */
export function consolidate(store) {
  let merged = 0, dropped = 0
  // 1) 删空
  const before = store.memories.length
  store.memories = store.memories.filter((m) => m.text && m.text.trim())
  dropped += before - store.memories.length
  // 2) 合并同 category + 同 project 的近重复
  const kept = []
  for (const m of store.memories) {
    let absorbed = false
    for (const k of kept) {
      if (k.category !== m.category || (k.project || '') !== (m.project || '')) continue
      if (jaccard(k.text, m.text) >= 0.72) {
        const b = { ...k }
        if (m.text.length > k.text.length) k.text = m.text
        k.importance = Math.max(k.importance, m.importance)
        k.updatedAt = Math.max(k.updatedAt, m.updatedAt)
        pushLog(store, 'consolidate-merge', [b, { ...m }], { ...k }, 'near-duplicate')
        merged++
        absorbed = true
        break
      }
    }
    if (!absorbed) kept.push(m)
  }
  store.memories = kept
  return { merged, dropped, total: store.memories.length }
}

export function undo(store) {
  const last = store.log.pop()
  if (!last) return { undone: false }
  if (last.action === 'forget' || last.action === 'consolidate-merge') {
    for (const m of last.before) {
      if (!store.memories.some((x) => x.id === m.id)) store.memories.push(m)
    }
  } else if (last.after) {
    const i = store.memories.findIndex((m) => m.id === last.after.id)
    const prev = last.before?.[0]
    if (i >= 0 && prev) store.memories[i] = prev
    else if (prev && i < 0) store.memories.push(prev)
  }
  return { undone: true, action: last.action }
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入：核心记忆 + 最近记忆 + 使用提示
// ─────────────────────────────────────────────────────────────────────────────

function relTime(ts) {
  const d = Math.max(0, Math.floor((Date.now() - ts) / 86400000))
  if (d === 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

function renderMemLine(m) {
  const cat = m.category && m.category !== 'other' ? `(${m.category}) ` : ''
  const proj = m.project ? ` [${m.project}]` : ''
  return `- ${cat}${m.text}${proj} · ${relTime(m.updatedAt || m.createdAt)}`
}

/** 组装要注入的系统提示词上下文。agent-loop 会把它记进日志（满足不变量）。 */
export function buildInjection(store) {
  const memories = store.memories.filter((m) => !m.archived)
  if (memories.length === 0) {
    return [
      '## 你的个人记忆',
      '你拥有一份关于这个人的长期记忆，目前还是空的。',
      '当对方告诉你关于他自己的长期事实（偏好、姓名、习惯、约束、决定）时，用 `memory_remember` 工具记下来，这样你下次就知道。',
    ].join('\n')
  }
  const core = memories
    .filter((m) => m.importance >= CORE_IMPORTANCE)
    .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
    .slice(0, INJECT_CORE_MAX)
  const recent = memories
    .slice()
    .sort((a, b) => (b.updatedAt - a.updatedAt))
    .slice(0, INJECT_RECENT_MAX)
  const seen = new Set()
  const lines = []
  for (const m of [...core, ...recent]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    lines.push(renderMemLine(m))
  }
  return [
    '## 你的个人记忆',
    `你已经知道的关于这个人的信息（共保留 ${memories.length} 条记忆）：`,
    ...lines,
    '',
    '在回答任何可能依赖「你已知的关于对方的信息」的问题之前，先用 `memory_recall` 检索；',
    '对方告诉你长期事实时用 `memory_remember` 记下；对方要求忘记时用 `memory_forget`。',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具定义（原始 ToolDefinition，零依赖）
// ─────────────────────────────────────────────────────────────────────────────

const textBlock = (text) => [{ type: 'text', text }]

function tool(name, description, parameters, schema, execute, render) {
  return {
    name,
    description,
    parameters,
    output: { schema, render: render || ((_a, v) => textBlock(typeof v === 'string' ? v : JSON.stringify(v, null, 2))) },
    async execute(args) { return execute(args || {}) },
  }
}

function buildTools(store, save) {
  const deferred = []
  const done = () => { save() }

  return [
    tool(
      'memory_remember',
      '记住关于这个人的一条长期事实，供以后的每次对话使用：偏好、姓名、习惯、约束、决定。一句话。当对方说了你下次应该知道的事情时使用。事实发生变化时，用 `replaces` 传入已有条目的 id 来更新，而不是新增第二条。绝不要存密码或支付信息。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', description: '事实，一句话，最多 400 字。' },
          category: { type: 'string', description: 'identity | preference | fact | project | lesson | goal | other' },
          importance: { type: 'integer', description: '1-5；3 及以上会始终保留在上下文中。默认 3。' },
          project: { type: 'string', description: '可选的项目/工作区名；留空表示全局。' },
          replaces: { type: 'string', description: '要更新的旧记忆 id（事实变了时用）。' },
        },
        required: ['text'],
      },
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' }, merged: { type: 'boolean' } } },
      (args) => {
        const r = remember(store, args)
        done()
        return { id: r.item.id, text: r.item.text, merged: r.merged || r.deduped }
      },
      (_a, v) => textBlock(`${v.merged ? '已更新' : '已记住'}：${v.text}（${v.id}）`),
    ),

    tool(
      'memory_recall',
      '在你的长期记忆中检索与 `query` 相关的事实。在回答任何可能依赖「你已知的关于对方的信息」的问题之前，先调用它。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要找什么。' },
          limit: { type: 'integer', description: '最多返回条数，1-50。默认 8。' },
          category: { type: 'string', description: '限定某一类别。' },
          project: { type: 'string', description: '限定某个项目（含全局）。' },
        },
        required: ['query'],
      },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
      (args) => {
        const items = recall(store, args.query, args)
        for (const m of items) { m.accessCount = (m.accessCount || 0) + 1; m.lastAccessedAt = Date.now() }
        done()
        return items.map((m) => ({ id: m.id, text: m.text }))
      },
      (_a, v) => textBlock(v.length ? v.map((m) => `- ${m.text}  （${m.id}）`).join('\n') : '没有匹配的记忆。'),
    ),

    tool(
      'memory_forget',
      '删除关于这个人的记忆。给 `id` 删一条，给 `query` 删掉所有包含该文字的记忆。对方要求忘记某事时使用。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '要删除的记忆 id。' }, query: { type: 'string', description: '删除所有包含该文字的记忆。' } } },
      { type: 'object', additionalProperties: false, properties: { removed: { type: 'integer' } } },
      (args) => { const r = forget(store, args); done(); return r },
      (_a, v) => textBlock(v.removed ? `已忘记 ${v.removed} 条记忆。` : '没有匹配到。'),
    ),

    tool(
      'memory_update',
      '按 id 修改一条已有记忆：文字、类别、重要性或项目。用来修正错误或过时的事实。',
      {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true, description: '要修改的记忆 id。' }, text: { type: 'string', description: '新的文字。' }, category: { type: 'string', description: '新的类别。' }, importance: { type: 'integer', description: '新的重要性 1-5。' }, project: { type: 'string', description: '新的项目归属。' } },
        required: ['id'],
      },
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' } } },
      (args) => { const it = update(store, args); done(); return it ? { id: it.id, text: it.text } : { id: '', text: '' } },
      (_a, v) => textBlock(v.id ? `已更新 ${v.id}：${v.text}` : '没有该 id 的记忆。'),
    ),

    tool(
      'memory_list',
      '列出你记得的关于这个人的全部内容，可按类别过滤。对方问「你知道我什么」时使用。',
      { type: 'object', additionalProperties: false, properties: { category: { type: 'string', description: '只列某一类别。' }, limit: { type: 'integer', description: '最多列几条，默认 60。' } } },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, category: { type: 'string' } } } },
      (args) => {
        const limit = Math.max(1, Math.min(200, Number(args.limit) || 60))
        return store.memories
          .filter((m) => !m.archived && (!args.category || m.category === args.category))
          .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
          .slice(0, limit)
          .map((m) => ({ id: m.id, text: m.text, category: m.category }))
      },
      (_a, v) => textBlock(v.length ? v.map((m) => `- （${m.category}）${m.text}  （${m.id}）`).join('\n') : '还没有记住任何东西。'),
    ),

    tool(
      'memory_consolidate',
      '整理你对这个人的记忆：合并近重复的条目、删除空条目。它绝不发明事实，也绝不删除对方自己写的内容。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { merged: { type: 'integer' }, dropped: { type: 'integer' }, total: { type: 'integer' } } },
      () => { const r = consolidate(store); done(); return r },
      (_a, v) => textBlock(`记忆已整理：合并 ${v.merged} 条，删除 ${v.dropped} 条；保留 ${v.total} 条。`),
    ),

    tool(
      'memory_undo',
      '撤销最近一次记忆改动（遗忘、合并或编辑）。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { undone: { type: 'boolean' }, action: { type: 'string' } } },
      () => { const r = undo(store); done(); return { undone: r.undone, action: r.action || '' } },
      (_a, v) => textBlock(v.undone ? `已撤销：${v.action}。` : '没有可撤销的改动。'),
    ),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 人类命令：/memory —— 不经模型，直接查看 / 删除 / 整理记忆
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_HELP = [
  'jt-da-pa 记忆命令：',
  '  /memory                    列出全部记忆',
  '  /memory list               同上',
  '  /memory forget <文字>      删除所有包含该文字的记忆',
  '  /memory forget id:<id>     按 id 删除一条',
  '  /memory undo               撤销最近一次删除/合并',
  '  /memory tidy               整理：合并近重复、删空',
  '  /memory help               显示本帮助',
  '',
  '记忆文件：$DSH_HOME/jt-da-pa-memory/memory.json（可直接编辑，改完重启或下轮生效）',
].join('\n')

export function commandList(store) {
  const items = store.memories
    .filter((m) => !m.archived)
    .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
  if (!items.length) return '你的记忆还是空的。当你说到关于自己的长期事实时，我会记下来。'
  const lines = [`你的个人记忆（共 ${items.length} 条）：`]
  for (const m of items) lines.push(`  ${renderMemLine(m)}  [${m.id}]`)
  lines.push('', '删除：/memory forget <文字>   或   /memory forget id:<id>')
  return lines.join('\n')
}

/** 构造 /memory 命令定义（零依赖：不 import @deepseek-ai/dsh-commands）。 */
export function memoryCommandDefinition(store, save) {
  return {
    name: 'memory',
    description: '查看 / 删除 / 整理 jt-da-pa 的个人记忆',
    input: { hint: '[list | forget <文字|id:xxx> | undo | tidy | help]' },
    handler({ rawInput }) {
      try {
        const input = String(rawInput || '').trim()
        const mm = /^(\S+)?\s*([\s\S]*)$/.exec(input)
        const verb = (mm?.[1] || 'list').toLowerCase()
        const arg = (mm?.[2] || '').trim()
        if (verb === 'list') return { kind: 'success', text: commandList(store) }
        if (verb === 'help') return { kind: 'success', text: MEMORY_HELP }
        if (verb === 'forget') {
          if (!arg) return { kind: 'error', text: '用法：/memory forget <文字>  或  /memory forget id:<id>' }
          if (arg.startsWith('id:')) {
            const id = arg.slice(3).trim()
            const r = forget(store, { id }); save()
            return r.removed
              ? { kind: 'success', text: `已删除记忆 ${id}。可用 /memory undo 撤销。` }
              : { kind: 'error', text: `没有 id 为 ${id} 的记忆。` }
          }
          const r = forget(store, { query: arg }); save()
          return r.removed
            ? { kind: 'success', text: `已删除 ${r.removed} 条包含「${arg}」的记忆。可用 /memory undo 撤销。` }
            : { kind: 'error', text: `没有包含「${arg}」的记忆。` }
        }
        if (verb === 'undo') {
          const r = undo(store); save()
          return r.undone
            ? { kind: 'success', text: `已撤销：${r.action}。` }
            : { kind: 'error', text: '没有可撤销的改动。' }
        }
        if (verb === 'tidy') {
          const r = consolidate(store); save()
          return { kind: 'success', text: `记忆已整理：合并 ${r.merged} 条，删除 ${r.dropped} 条；保留 ${r.total} 条。` }
        }
        return { kind: 'error', text: `未知子命令：${verb}\n\n${MEMORY_HELP}` }
      } catch (e) {
        return { kind: 'error', text: '记忆命令出错：' + (e && e.message ? e.message : String(e)) }
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

export const name = 'jt-da-pa-memory'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const file = storePath(config)
  const store = loadStore(file)
  const save = () => { try { saveStore(file, store) } catch (e) { safeLog(ctx, 'save failed: ' + e.message) } }

  // 1) 注册工具
  for (const t of buildTools(store, save)) {
    ctx.effect(() => ctx.tools.register(t), `jt-da-pa-memory: ${t.name}`)
  }

  // 2) 注入系统提示词上下文（systemPrompt 是可选的，别的 profile 可能没挂）
  ctx.inject(['systemPrompt'], (sysCtx) => {
    ctx.effect(
      () => sysCtx.systemPrompt.context({
        name: 'jt-da-pa-memory',
        order: 45,
        text: () => {
          try { return buildInjection(store) } catch { return '' }
        },
      }),
      'jt-da-pa-memory: prompt context',
    )
  })

  // 3) /memory 人类命令（不经模型，直接查看 / 管理）
  ctx.inject(['commands'], (cmdCtx) => {
    ctx.effect(
      () => cmdCtx.commands.register(memoryCommandDefinition(store, save)),
      'jt-da-pa-memory: /memory command',
    )
  })

  safeLog(ctx, `loaded ${store.memories.length} memories from ${file}`)
}

function safeLog(ctx, msg) {
  try { ctx.logger?.info?.(`jt-da-pa-memory: ${msg}`) } catch { /* ignore */ }
}