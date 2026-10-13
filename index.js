/**
 * jt-da-pa-memory — 一个「个人 AI」风格的跨会话记忆插件（DeepSeek Harness）。
 *
 * 三大能力：
 *   ① 个性化长期记忆：记住「你这个人」（身份 / 偏好 / 事实），可读可改，带出处，
 *      相关性 + 重要性 + 时间衰减打分，核心画像（【关于你】）每轮注入。
 *   ② 主动打扰（结合 dsh 定时服务）：memory_remind 经 ctx.schedule 排定一次
 *      「主动告诉用户」的唤醒；到点由 dsh-schedule 唤醒会话并由 agent 主动找你说。
 *   ③ dream（空闲整理）：记忆写入空闲若干分钟后，自动整理（合并近重复、删空、
 *      归档陈旧低价值条目），可撤销；也可用 memory_dream / /dream 手动触发。
 *
 * 实现对齐 dsh 官方模式「section provider + tool」：
 *   · 写入/检索：ctx.tools.register()       · 注入：ctx.systemPrompt.context()
 *   · 主动打扰：ctx.schedule（可选服务）     · 人类命令：ctx.commands（可选服务）
 *   · 存储：插件自有 JSON（不写进 session log）
 *
 * 零运行时依赖：只用 node 内置模块 + ctx.* 方法调用，不 import 任何 dsh 包。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ─────────────────────────────────────────────────────────────────────────────
// 常量与配置
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['identity', 'preference', 'fact', 'project', 'lesson', 'goal', 'other']
const MAX_MEMORIES = 800
const MAX_TEXT = 400
const MERGE_SIMILARITY = 0.82
const CORE_IMPORTANCE = 3
const INJECT_CORE_MAX = 12
const INJECT_RECENT_MAX = 6
const HALF_LIFE_DAYS = 45

const DREAM_DEFAULTS = { enabled: true, idleMinutes: 30, archiveAfterDays: 120 }
const PROACTIVE_DEFAULTS = { enabled: true }

/** 归一化插件配置（来自 cordis.patch.yml 的 config）。 */
export function resolveConfig(config) {
  const c = config || {}
  const d = c.dream || {}
  const p = c.proactive || {}
  return {
    dir: typeof c.dir === 'string' && c.dir.trim() ? c.dir : join(dshHome(), 'jt-da-pa-memory'),
    dream: {
      enabled: d.enabled !== false,
      idleMinutes: Number.isFinite(Number(d.idleMinutes)) ? Math.max(1, Number(d.idleMinutes)) : DREAM_DEFAULTS.idleMinutes,
      archiveAfterDays: Number.isFinite(Number(d.archiveAfterDays)) ? Math.max(0, Number(d.archiveAfterDays)) : DREAM_DEFAULTS.archiveAfterDays,
    },
    proactive: { enabled: p.enabled !== false },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 存储：$DSH_HOME/jt-da-pa-memory/memory.json
// ─────────────────────────────────────────────────────────────────────────────

function dshHome() {
  const home = process.env.DSH_HOME
  if (home && home.trim()) return home
  return join(homedir(), '.dsh')
}

function storePath(config) { return join(config.dir, 'memory.json') }

function emptyStore() {
  return { version: 2, memories: [], log: [], lastWriteAt: 0, lastDreamAt: 0, dreams: 0, updatedAt: 0 }
}

function loadStore(file) {
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.memories)) {
        return {
          version: 2, memories: raw.memories, log: raw.log || [],
          lastWriteAt: raw.lastWriteAt || 0, lastDreamAt: raw.lastDreamAt || 0,
          dreams: raw.dreams || 0, updatedAt: raw.updatedAt || 0,
        }
      }
    }
  } catch {
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

const WORD_RE = /[^\W_\u3400-\u9fff]+/g
const CJK_RE = /[\u3400-\u9fff]/g

/** 分词：字母词（小写，去复数 s）+ CJK 相邻 2-gram。 */
export function tokenize(text) {
  const out = new Set()
  for (const w of String(text || '').toLowerCase().match(WORD_RE) || []) {
    if (w.length <= 1) continue
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

function importanceWeight(n) { return 0.5 + Math.max(1, Math.min(5, Number(n) || 3)) * 0.2 }
function recencyDecay(ts) { return Math.pow(0.5, Math.max(0, (Date.now() - (ts || 0)) / 86400000) / HALF_LIFE_DAYS) }

function idfTable(memories) {
  const df = new Map()
  for (const m of memories) for (const t of tokenize(m.text)) df.set(t, (df.get(t) || 0) + 1)
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
  if (store.log.length > 300) store.log.splice(0, store.log.length - 300)
}

function touch(store) { store.lastWriteAt = Date.now() }

/** 写入；完全相同 / 高度相似则合并，replaces 显式更新，返回 { item, merged, deduped }。 */
export function remember(store, input) {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!text) throw new Error('memory text is empty')
  const category = CATEGORIES.includes(input.category) ? input.category : 'other'
  const project = String(input.project || '').trim()
  const importance = Math.max(1, Math.min(5, Number(input.importance) || 3))
  const now = Date.now()

  const exact = store.memories.find((m) => m.text.toLowerCase() === text.toLowerCase())
  if (exact) return { item: exact, merged: false, deduped: true }

  if (input.replaces) {
    const target = store.memories.find((m) => m.id === input.replaces)
    if (target) {
      const b = { ...target }
      target.text = text
      if (input.category) target.category = category
      target.importance = Math.max(target.importance, importance)
      target.updatedAt = now
      pushLog(store, 'update', [b], { ...target }, `replaces ${input.replaces}`)
      touch(store)
      return { item: target, merged: true, deduped: false }
    }
  }

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
    touch(store)
    return { item: best, merged: true, deduped: false }
  }

  const item = {
    id: newId(), text, category, project, importance,
    source: input.source || { kind: 'agent' },
    createdAt: now, updatedAt: now, accessCount: 0, lastAccessedAt: 0,
  }
  store.memories.push(item)
  if (store.memories.length > MAX_MEMORIES) store.memories.splice(0, store.memories.length - MAX_MEMORIES)
  touch(store)
  return { item, merged: false, deduped: false }
}

export function recall(store, query, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 8))
  const project = opts.project || ''
  const category = opts.category || ''
  const pool = store.memories.filter((m) =>
    !m.archived && projectMatches(m, project) && (!category || m.category === category))
  if (pool.length === 0) return []
  const qTokens = tokenize(query || '')
  if (qTokens.size === 0) {
    return [...pool].sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt)).slice(0, limit)
  }
  const idf = idfTable(pool)
  return pool
    .map((m) => ({ m, s: scoreMem(m, qTokens, idf) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.m)
}

export function forget(store, { id, query }) {
  if (id) {
    const i = store.memories.findIndex((m) => m.id === id)
    if (i < 0) return { removed: 0 }
    const [item] = store.memories.splice(i, 1)
    pushLog(store, 'forget', [item], null, `id ${id}`)
    touch(store)
    return { removed: 1 }
  }
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { removed: 0 }
  const hit = store.memories.filter((m) => m.text.toLowerCase().includes(q))
  if (hit.length === 0) return { removed: 0 }
  store.memories = store.memories.filter((m) => !hit.includes(m))
  pushLog(store, 'forget', hit, null, `matched "${query}"`)
  touch(store)
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
  touch(store)
  return item
}

/** 整理：合并近重复 + 删除空条目。只做「代码能确定判断」的事，不发明事实。 */
export function consolidate(store) {
  let merged = 0, dropped = 0
  const before = store.memories.length
  store.memories = store.memories.filter((m) => m.text && m.text.trim())
  dropped += before - store.memories.length
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
  touch(store)
  return { merged, dropped, total: store.memories.filter((m) => !m.archived).length }
}

/** 归档陈旧、低价值、长期未访问的记忆（dream 的一部分，可撤销）。 */
export function archiveStale(store, days) {
  if (!(days > 0)) return { archived: 0 }
  const cutoff = Date.now() - days * 86400000
  let archived = 0
  for (const m of store.memories) {
    if (m.archived) continue
    if (m.importance >= 3) continue                                  // 高价值不归档
    const last = Math.max(m.lastAccessedAt || 0, m.updatedAt || 0, m.createdAt || 0)
    if (m.accessCount === 0 && last < cutoff) {
      m.archived = true
      pushLog(store, 'archive', [{ ...m, archived: false }], { ...m }, `stale > ${days}d`)
      archived++
    }
  }
  touch(store)
  return { archived }
}

/** dream：整理 + 归档，返回报告。 */
export function dream(store, config) {
  const c = consolidate(store)
  const a = archiveStale(store, config.dream.archiveAfterDays)
  store.lastDreamAt = Date.now()
  store.dreams = (store.dreams || 0) + 1
  return { merged: c.merged, dropped: c.dropped, archived: a.archived, total: c.total }
}

export function undo(store) {
  const last = store.log.pop()
  if (!last) return { undone: false }
  if (last.action === 'forget' || last.action === 'consolidate-merge' || last.action === 'archive') {
    for (const m of last.before) {
      const i = store.memories.findIndex((x) => x.id === m.id)
      if (i >= 0) store.memories[i] = m
      else store.memories.push(m)
    }
  } else if (last.after) {
    const i = store.memories.findIndex((m) => m.id === last.after.id)
    const prev = last.before?.[0]
    if (i >= 0 && prev) store.memories[i] = prev
    else if (prev && i < 0) store.memories.push(prev)
  }
  touch(store)
  return { undone: true, action: last.action }
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入：个性化画像（关于你）+ 核心 + 最近 + 使用提示
// ─────────────────────────────────────────────────────────────────────────────

function relTime(ts) {
  const d = Math.max(0, Math.floor((Date.now() - ts) / 86400000))
  if (d === 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

function line(m) {
  const proj = m.project ? ` [${m.project}]` : ''
  return `- ${m.text}${proj} · ${relTime(m.updatedAt || m.createdAt)}`
}

/** 个性化画像：身份 + 偏好（就是「关于你」）。 */
export function profileOf(store) {
  const live = store.memories.filter((m) => !m.archived)
  const identity = live.filter((m) => m.category === 'identity').sort((a, b) => b.importance - a.importance)
  const pref = live.filter((m) => m.category === 'preference').sort((a, b) => b.importance - a.importance)
  return { identity, preference: pref }
}

/** 组装要注入的系统提示词上下文（agent-loop 会记进日志，满足 Model-visible ⟺ logged）。 */
export function buildInjection(store) {
  const live = store.memories.filter((m) => !m.archived)
  if (live.length === 0) {
    return [
      '## 你的个人记忆',
      '你拥有一份关于这个人的长期记忆，目前还是空的。',
      '当对方告诉你关于他自己的长期事实（偏好、姓名、习惯、约束、决定）时，用 `memory_remember` 记下来，这样你下次就知道。',
    ].join('\n')
  }
  const { identity, preference } = profileOf(store)
  const core = live
    .filter((m) => m.importance >= CORE_IMPORTANCE)
    .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
    .slice(0, INJECT_CORE_MAX)
  const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, INJECT_RECENT_MAX)

  const out = ['## 你的个人记忆']
  const about = [...identity, ...preference]
  if (about.length) {
    out.push('### 关于你')
    for (const m of about.slice(0, 10)) out.push(line(m))
  }
  const seen = new Set(about.map((m) => m.id))
  const others = [...core, ...recent].filter((m) => !seen.has(m.id))
  if (others.length) {
    out.push('### 其他记住的')
    for (const m of others) { if (seen.has(m.id)) continue; seen.add(m.id); out.push(line(m)) }
  }
  out.push('', `（共保留 ${live.length} 条记忆）`)
  out.push('在回答可能依赖「你已知的关于对方的信息」的问题前，先用 `memory_recall` 检索；',
    '对方告诉你长期事实时用 `memory_remember` 记下；对方要你忘记时用 `memory_forget`。')
  return out.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具定义（原始 ToolDefinition，零依赖）
// ─────────────────────────────────────────────────────────────────────────────

const textBlock = (text) => [{ type: 'text', text }]

function tool(name, description, parameters, schema, execute, render, presentCall) {
  return {
    name, description, parameters,
    output: { schema, render: render || ((_a, v) => textBlock(typeof v === 'string' ? v : JSON.stringify(v, null, 2))) },
    async execute(args, exec) { return execute(args || {}, exec) },
    ...(presentCall ? { presentCall } : {}),
  }
}

function buildTools(store, save, ctx, scheduleRef, cfg) {
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
      (args) => { const r = remember(store, args); save(); return { id: r.item.id, text: r.item.text, merged: r.merged || r.deduped } },
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
        save()
        return items.map((m) => ({ id: m.id, text: m.text }))
      },
      (_a, v) => textBlock(v.length ? v.map((m) => `- ${m.text}  （${m.id}）`).join('\n') : '没有匹配的记忆。'),
    ),

    tool(
      'memory_forget',
      '删除关于这个人的记忆。给 `id` 删一条，给 `query` 删掉所有包含该文字的记忆。对方要求忘记某事时使用。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '要删除的记忆 id。' }, query: { type: 'string', description: '删除所有包含该文字的记忆。' } } },
      { type: 'object', additionalProperties: false, properties: { removed: { type: 'integer' } } },
      (args) => { const r = forget(store, args); save(); return r },
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
      (args) => { const it = update(store, args); save(); return it ? { id: it.id, text: it.text } : { id: '', text: '' } },
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
      'memory_profile',
      '读取你对这个人的「个性化画像」：身份与偏好。当你想快速确认对方是谁、喜欢怎样被对待时使用。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { identity: { type: 'array' }, preference: { type: 'array' } } },
      () => {
        const p = profileOf(store)
        return { identity: p.identity.map((m) => ({ id: m.id, text: m.text })), preference: p.preference.map((m) => ({ id: m.id, text: m.text })) }
      },
      (_a, v) => textBlock(
        [v.identity.length ? '关于你（身份）：\n' + v.identity.map((m) => `- ${m.text}`).join('\n') : '（尚无身份信息）',
         v.preference.length ? '偏好：\n' + v.preference.map((m) => `- ${m.text}`).join('\n') : '（尚无偏好）'].join('\n\n')),
    ),

    tool(
      'memory_remind',
      '安排一次「主动打扰」：到点由定时服务唤醒你，你主动去找用户说这件事。用于「提醒我……」「……的时候告诉我」「每天/每周……」这类请求。必须给一个时间：after_seconds（几秒后）/ at（绝对时刻）/ daily / weekly / cron 之一。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', description: '到点要主动告诉用户的内容（一句话）。' },
          title: { type: 'string', description: '提醒的名字，最多 120 字。缺省取 text 前 40 字。' },
          after_seconds: { type: 'integer', description: '多少秒后（一次性）。' },
          at: { type: 'string', description: '绝对时刻，ISO 字符串（一次性）。' },
          daily: { type: 'object', description: '每日：{ time: "HH:mm:ss", time_zone: "Asia/Shanghai" }' },
          weekly: { type: 'object', description: '每周：{ time, time_zone, weekdays: [1..7] }' },
          cron: { type: 'object', description: 'cron：{ expression, time_zone }' },
        },
        required: ['text'],
      },
      { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' }, error: { type: 'string' } } },
      async (args, exec) => {
        const svc = scheduleRef.service
        if (!svc) return { ok: false, id: '', title: '', error: '此 profile 未启用定时服务（dsh-schedule），无法安排主动提醒。' }
        const agent = exec && exec.agent
        if (!agent || !agent.session || !agent.session.id) return { ok: false, id: '', title: '', error: '无法确定当前会话。' }
        const req = { prompt: args.text, title: String(args.title || args.text).slice(0, 120) }
        for (const k of ['after_seconds', 'at', 'daily', 'weekly', 'cron', 'every_seconds']) if (args[k] != null) req[k] = args[k]
        if (!['after_seconds', 'at', 'daily', 'weekly', 'cron', 'every_seconds'].some((k) => req[k] != null)) {
          return { ok: false, id: '', title: '', error: '必须给一个时间：after_seconds / at / daily / weekly / cron。' }
        }
        try {
          const rec = await svc.create(agent.session.id, req, exec.signal)
          return { ok: true, id: String(rec.id), title: String(rec.title || req.title), error: '' }
        } catch (e) {
          return { ok: false, id: '', title: '', error: '安排失败：' + (e && e.message ? e.message : String(e)) }
        }
      },
      (_a, v) => textBlock(v.ok ? `已安排主动提醒「${v.title}」（${v.id}）。到点我会主动找你。` : v.error),
      (args) => ({ card: 'generic', title: `主动提醒：${(args.text || '').slice(0, 40)}`, kind: 'other', rawInput: args }),
    ),

    tool(
      'memory_reminders',
      '列出本会话已安排的主动提醒。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
      async (_args, exec) => {
        const svc = scheduleRef.service
        const agent = exec && exec.agent
        if (!svc || !agent || !agent.session || !agent.session.id) return []
        try {
          const list = await svc.list({ sessionId: agent.session.id })
          return (list || []).map((r) => ({ id: String(r.id), title: String(r.title || '') }))
        } catch { return [] }
      },
      (_a, v) => textBlock(v.length ? v.map((r) => `- ${r.title}  （${r.id}）`).join('\n') : '本会话没有已安排的提醒。'),
    ),

    tool(
      'memory_cancel_reminder',
      '按 id 取消一条本会话已安排的主动提醒。',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true, description: '要取消的提醒 id。' } }, required: ['id'] },
      { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      async (args, exec) => {
        const svc = scheduleRef.service
        const agent = exec && exec.agent
        if (!svc || !agent || !agent.session || !agent.session.id) return { ok: false, error: '定时服务或会话不可用。' }
        try { await svc.delete({ sessionId: agent.session.id, id: args.id }, exec.signal); return { ok: true, error: '' } }
        catch (e) { return { ok: false, error: '取消失败：' + (e && e.message ? e.message : String(e)) } }
      },
      (_a, v) => textBlock(v.ok ? '已取消该提醒。' : v.error),
    ),

    tool(
      'memory_dream',
      '手动整理记忆：合并近重复、删除空条目、归档陈旧低价值条目。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { merged: { type: 'integer' }, dropped: { type: 'integer' }, archived: { type: 'integer' }, total: { type: 'integer' } } },
      () => { const r = dream(store, cfg); save(); return r },
      (_a, v) => textBlock(`记忆已整理：合并 ${v.merged} 条，删除 ${v.dropped} 条，归档 ${v.archived} 条；保留 ${v.total} 条。`),
    ),

    tool(
      'memory_undo',
      '撤销最近一次记忆改动（遗忘、合并、归档或编辑）。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { undone: { type: 'boolean' }, action: { type: 'string' } } },
      () => { const r = undo(store); save(); return { undone: r.undone, action: r.action || '' } },
      (_a, v) => textBlock(v.undone ? `已撤销：${v.action}。` : '没有可撤销的改动。'),
    ),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 人类命令：/memory 与 /dream（不经模型）
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_HELP = [
  'jt-da-pa 记忆命令：',
  '  /memory                    列出全部记忆',
  '  /memory forget <文字>      删除所有包含该文字的记忆',
  '  /memory forget id:<id>     按 id 删除一条',
  '  /memory undo               撤销最近一次删除/合并/归档',
  '  /memory tidy               整理（同 dream）',
  '  /dream                     手动整理记忆',
  '  /memory help               显示本帮助',
  '',
  '记忆文件：$DSH_HOME/jt-da-pa-memory/memory.json（可直接编辑）',
].join('\n')

export function commandList(store) {
  const live = store.memories.filter((m) => !m.archived)
  if (!live.length) return '你的记忆还是空的。当你说到关于自己的长期事实时，我会记下来。'
  const { identity, preference } = profileOf(store)
  const out = [`你的个人记忆（共 ${live.length} 条）：`]
  const about = [...identity, ...preference]
  if (about.length) {
    out.push('【关于你】')
    for (const m of about) out.push(`  ${m.text}  [${m.id}]`)
  }
  const others = live.filter((m) => !about.includes(m))
  if (others.length) {
    out.push('【其他】')
    for (const m of others.sort((a, b) => b.updatedAt - a.updatedAt)) out.push(`  （${m.category}）${m.text} · ${relTime(m.updatedAt)}  [${m.id}]`)
  }
  const archived = store.memories.filter((m) => m.archived).length
  if (archived) out.push('', `（另有 ${archived} 条已归档）`)
  out.push('', '删除：/memory forget <文字>   或   /memory forget id:<id>')
  return out.join('\n')
}

export function memoryCommandDefinition(store, save, cfg) {
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
            return r.removed ? { kind: 'success', text: `已删除记忆 ${id}。可用 /memory undo 撤销。` } : { kind: 'error', text: `没有 id 为 ${id} 的记忆。` }
          }
          const r = forget(store, { query: arg }); save()
          return r.removed ? { kind: 'success', text: `已删除 ${r.removed} 条包含「${arg}」的记忆。可用 /memory undo 撤销。` } : { kind: 'error', text: `没有包含「${arg}」的记忆。` }
        }
        if (verb === 'undo') { const r = undo(store); save(); return r.undone ? { kind: 'success', text: `已撤销：${r.action}。` } : { kind: 'error', text: '没有可撤销的改动。' } }
        if (verb === 'tidy') { const r = dream(store, cfg); save(); return { kind: 'success', text: `记忆已整理：合并 ${r.merged}，删除 ${r.dropped}，归档 ${r.archived}；保留 ${r.total}。` } }
        return { kind: 'error', text: `未知子命令：${verb}\n\n${MEMORY_HELP}` }
      } catch (e) { return { kind: 'error', text: '记忆命令出错：' + (e && e.message ? e.message : String(e)) } }
    },
  }
}

export function dreamCommandDefinition(store, save, cfg) {
  return {
    name: 'dream',
    description: '手动整理 jt-da-pa 的记忆（dream）：合并近重复、删空、归档陈旧条目',
    handler() {
      try { const r = dream(store, cfg); save(); return { kind: 'success', text: `🧠 dream 完成：合并 ${r.merged}，删除 ${r.dropped}，归档 ${r.archived}；保留 ${r.total}。` } }
      catch (e) { return { kind: 'error', text: 'dream 失败：' + (e && e.message ? e.message : String(e)) } }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

export const name = 'jt-da-pa-memory'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const file = storePath(cfg)
  const store = loadStore(file)
  const save = () => { try { saveStore(file, store) } catch (e) { safeLog(ctx, 'save failed: ' + (e && e.message)) } }

  // 可选服务引用（schedule 用于主动打扰；缺席时相关工具返回明确错误）
  const scheduleRef = { service: null }
  ctx.inject(['schedule'], (sctx) => { scheduleRef.service = sctx.schedule })

  // 1) 工具
  for (const t of buildTools(store, save, ctx, scheduleRef, cfg)) {
    ctx.effect(() => ctx.tools.register(t), `jt-da-pa-memory: ${t.name}`)
  }

  // 2) 系统提示词上下文（个性化画像 + 核心 + 最近）
  ctx.inject(['systemPrompt'], (sysCtx) => {
    ctx.effect(
      () => sysCtx.systemPrompt.context({
        name: 'jt-da-pa-memory',
        order: 45,
        text: () => { try { return buildInjection(store) } catch { return '' } },
      }),
      'jt-da-pa-memory: prompt context',
    )
  })

  // 3) 人类命令 /memory、/dream
  ctx.inject(['commands'], (cmdCtx) => {
    ctx.effect(() => cmdCtx.commands.register(memoryCommandDefinition(store, save, cfg)), 'jt-da-pa-memory: /memory')
    ctx.effect(() => cmdCtx.commands.register(dreamCommandDefinition(store, save, cfg)), 'jt-da-pa-memory: /dream')
  })

  // 4) dream 空闲整理（每 60s 检查一次；空闲 ≥ idleMinutes 且自上次 dream 后有过写入）
  if (cfg.dream.enabled) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const now = Date.now()
          const lastWrite = store.lastWriteAt || 0
          const lastDream = store.lastDreamAt || 0
          if (lastWrite === 0) return                     // 从未写入，不 dream
          if (now - lastWrite < cfg.dream.idleMinutes * 60000) return   // 还不够空闲
          if (lastDream >= lastWrite) return              // 本次写入后已 dream 过
          const r = dream(store, cfg)
          save()
          safeLog(ctx, `dream（空闲 ${cfg.dream.idleMinutes} 分钟）：${JSON.stringify(r)}`)
        } catch (e) { safeLog(ctx, 'dream failed: ' + (e && e.message)) }
      }, 60000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'jt-da-pa-memory: dream timer')
  }

  safeLog(ctx, `已加载 ${store.memories.length} 条记忆（${file}）；dream=${cfg.dream.enabled ? '开' : '关'}，主动打扰=${cfg.proactive.enabled ? '开' : '关'}`)
}

function safeLog(ctx, msg) {
  try { ctx.logger?.info?.(`jt-da-pa-memory: ${msg}`) } catch { /* ignore */ }
}