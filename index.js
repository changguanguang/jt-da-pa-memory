/**
 * jt-da-pa-memory — 一个「个人 AI」风格的跨会话记忆插件 (DeepSeek Harness)。
 *
 * 核心能力 (v0.3.0)：
 *   ① 个性化长期记忆：记住「你这个人」(身份 / 偏好 / 事实 / 教训 / 目标)，可读可改，带出处，
 *      相关性 + 重要性 + 时间衰减 + 访问频次打分，核心画像 (【关于你】) 每轮注入。
 *   ② 双时态事实演化链 (Bi-Temporal History)：事实更新或替换时自动保留历史轨迹 (曾: ...)，
 *      让 AI 理解你的状态与偏好是如何随时间演变的。
 *   ③ 阶段性情境记忆 (Episodic TTL)：支持 expires_in_days 临时情境记忆（如短期出差、冲刺阶段），
 *      有效期内高优注入，到期自动静默归档，不污染长期画像。
 *   ④ 冲突与关联预警 (Conflict Guard) + 避坑准则专席 (Lessons)：写入时自动检测同类别潜在冲突记忆；
 *      历史踩坑教训 (lesson) 独立高优注入。
 *   ⑤ 主动打扰 (结合 dsh 定时服务) + dream (空闲整理，原子可撤销) + Markdown 导出 (/memory export)。
 *
 * 零运行时依赖：只用 node 内置模块 + ctx.* 方法调用，不 import 任何 dsh 包。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------

const CATEGORIES = ['identity', 'preference', 'fact', 'project', 'lesson', 'goal', 'other']
const MAX_MEMORIES = 800
const MAX_TEXT = 400
const MAX_HISTORY = 5
const MERGE_SIMILARITY = 0.82
const CONFLICT_MIN_SIMILARITY = 0.10
const CORE_IMPORTANCE = 3
const INJECT_CORE_MAX = 12
const INJECT_RECENT_MAX = 6
const HALF_LIFE_DAYS = 45
const TIME_SELECTOR_KEYS = ['after_seconds', 'at', 'daily', 'weekly', 'cron', 'every_seconds']

const DREAM_DEFAULTS = { enabled: true, idleMinutes: 30, archiveAfterDays: 120 }
const PROACTIVE_DEFAULTS = { enabled: true }

/** 归一化插件配置 (来自 cordis.patch.yml 的 config)。 */
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
    autoTtl: c.autoTtl !== false,
  }
}

// ---------------------------------------------------------------------------
// 存储: $DSH_HOME/jt-da-pa-memory/memory.json
// ---------------------------------------------------------------------------

function dshHome() {
  const home = process.env.DSH_HOME
  if (home && home.trim()) return home
  return join(homedir(), '.dsh')
}

function storePath(config) { return join(config.dir, 'memory.json') }

function emptyStore() {
  return { version: 2, memories: [], log: [], lastWriteAt: 0, lastDreamAt: 0, dreams: 0, updatedAt: 0 }
}

function getMtime(file) {
  try { return existsSync(file) ? statSync(file).mtimeMs : 0 } catch { return 0 }
}

function loadStore(file) {
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.memories)) {
        const s = {
          version: 2, memories: raw.memories, log: raw.log || [],
          lastWriteAt: raw.lastWriteAt || 0, lastDreamAt: raw.lastDreamAt || 0,
          dreams: raw.dreams || 0, updatedAt: raw.updatedAt || 0,
        }
        Object.defineProperty(s, '_mtime', { value: getMtime(file), writable: true, enumerable: false })
        return s
      }
    }
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
  }
  const s = emptyStore()
  Object.defineProperty(s, '_mtime', { value: 0, writable: true, enumerable: false })
  return s
}

/** 若外部进程或用户手动修改了 memory.json，则在操作前热同步内存状态。 */
function syncStoreFromDisk(file, store) {
  try {
    const diskMtime = getMtime(file)
    if (diskMtime > 0 && store._mtime && diskMtime > store._mtime) {
      const fresh = loadStore(file)
      store.version = fresh.version
      store.memories = fresh.memories
      store.log = fresh.log
      store.lastWriteAt = fresh.lastWriteAt
      store.lastDreamAt = fresh.lastDreamAt
      store.dreams = fresh.dreams
      store.updatedAt = fresh.updatedAt
      store._mtime = fresh._mtime
    }
  } catch { /* ignore */ }
}

function saveStore(file, store) {
  store.updatedAt = Date.now()
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
  store._mtime = getMtime(file)
}

// ---------------------------------------------------------------------------
// 分词与打分
// ---------------------------------------------------------------------------

const WORD_RE = /[^\W_\u3400-\u9fff]+/g
const CJK_SEG_RE = /[\u3400-\u9fff]+/g
const NON_PLURAL_S = new Set([
  'always', 'sometimes', 'series', 'species', 'status', 'focus', 'paris',
  'texas', 'canvas', 'alias', 'basis', 'crisis', 'analysis', 'thesis',
  'synopsis', 'lens', 'bus', 'gas', 'plus', 'minus', 'virus', 'campus',
  'bonus', 'radius', 'census', 'corpus', 'nexus', 'nodejs', 'nextjs',
  'nuxtjs', 'vuejs', 'reactjs', 'expressjs', 'nestjs', 'redis', 'k8s', 'aws', 'ios', 'macos',
])

function stemEnglish(w) {
  if (w.length <= 3 || NON_PLURAL_S.has(w)) return w
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1)
  }
  return w
}

/** 分词: 字母/数字词 (小写, 英文轻量词干化) + CJK 连续片段内相邻 2-gram。 */
export function tokenize(text) {
  const out = new Set()
  for (const w of String(text || '').toLowerCase().match(WORD_RE) || []) {
    if (w.length === 1 && !/^\d$/.test(w)) continue
    out.add(stemEnglish(w))
  }
  for (const seg of String(text || '').match(CJK_SEG_RE) || []) {
    if (seg.length === 1) {
      out.add(seg)
    } else {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
    }
  }
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

/** 判断记忆是否处于活跃未过期状态。 */
function isLive(mem, now = Date.now()) {
  if (mem.archived) return false
  if (mem.expiresAt && mem.expiresAt <= now) return false
  return true
}

/** 中文数字 → 阿拉伯数字（处理 0-99 的常见写法）。 */
const CN_DIGITS = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
function cn2num(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  if (s.length === 2 && s[0] === '十') return 10 + (CN_DIGITS[s[1]] || 0)
  if (s.length === 2 && s[1] === '十') return (CN_DIGITS[s[0]] || 0) * 10
  return CN_DIGITS[s] || 0
}

/**
 * 保守地从文本推断「临时状态」的天数：只在明确的时长表述上触发，否则返回 0（= 不过期）。
 * 这样即使模型忘了传 expires_in_days，"本周出差"这类也会自动得到一个过期时间。
 * @param text - 记忆正文。
 * @returns 推断出的天数（0 表示非临时）。
 */
export function inferTtlDays(text) {
  const t = String(text || '')
  const N = '[0-9零一二两三四五六七八九十]+'
  let m
  if ((m = new RegExp(`为期\\s*(${N})\\s*天`).exec(t))) { const n = cn2num(m[1]); if (n > 0) return Math.min(730, n) }
  if ((m = new RegExp(`为期\\s*(${N})\\s*(?:个)?周`).exec(t))) { const n = cn2num(m[1]); if (n > 0) return Math.min(730, n * 7) }
  if ((m = new RegExp(`为期\\s*(${N})\\s*(?:个)?月`).exec(t))) { const n = cn2num(m[1]); if (n > 0) return Math.min(730, n * 30) }
  if (/本周|这周|这周内|本周内|这个星期/.test(t)) return 7
  if (/这几?天|近几天/.test(t)) return 3
  if (/(临时|暂时)/.test(t)) return 3
  return 0
}

function scoreMem(mem, qTokens, idf) {
  const tokens = tokenize(mem.text)
  let s = 0
  for (const t of qTokens) if (tokens.has(t)) s += idf.get(t) ?? Math.log(2)
  const accessBoost = 1 + Math.min(0.3, Math.log1p(mem.accessCount || 0) * 0.08)
  return s * importanceWeight(mem.importance) * recencyDecay(mem.updatedAt || mem.createdAt) * accessBoost
}

// ---------------------------------------------------------------------------
// 记忆操作
// ---------------------------------------------------------------------------

function newId() { return 'pm_' + randomBytes(4).toString('hex') }

function pushLog(store, action, before, after, reason) {
  store.log.push({ at: Date.now(), action, before, after: after || null, reason: reason || '' })
  if (store.log.length > 300) store.log.splice(0, store.log.length - 300)
}

function touch(store) { store.lastWriteAt = Date.now() }

/** 记录事实演变轨迹 (最多保留最近 MAX_HISTORY 条历史版本)。 */
function recordHistory(target, oldText, oldUpdatedAt) {
  if (!oldText || oldText.trim().toLowerCase() === String(target.text || '').trim().toLowerCase()) return
  const hist = Array.isArray(target.history) ? [...target.history] : []
  hist.push({ text: oldText, at: oldUpdatedAt || Date.now() })
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY)
  target.history = hist
}

/** 智能淘汰：超过 MAX_MEMORIES 时优先清理已归档/已过期条目，其次清理低重要度且最久未更新的非核心条目。 */
function enforceMaxMemories(store) {
  const now = Date.now()
  while (store.memories.length > MAX_MEMORIES) {
    let victimIdx = store.memories.findIndex((m) => !isLive(m, now))
    if (victimIdx < 0) {
      let lowestScore = Infinity
      for (let i = 0; i < store.memories.length; i++) {
        const m = store.memories[i]
        const isProfile = m.category === 'identity' || m.category === 'preference'
        const rank = (m.importance || 3) * 10 + (isProfile ? 25 : 0) + Math.min(10, m.accessCount || 0)
        const ageFactor = (m.updatedAt || m.createdAt || 0) / 1e13
        const score = rank + ageFactor
        if (score < lowestScore) {
          lowestScore = score
          victimIdx = i
        }
      }
    }
    if (victimIdx >= 0) store.memories.splice(victimIdx, 1)
    else break
  }
}

/** 写入；完全相同 / 高度相似则合并，replaces 显式更新，返回 { item, merged, deduped, related }。 */
export function remember(store, input) {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!text) throw new Error('memory text is empty')
  const category = CATEGORIES.includes(input.category) ? input.category : 'other'
  const project = String(input.project || '').trim()
  const importance = Math.max(1, Math.min(5, Number(input.importance) || 3))
  const now = Date.now()
  const expiresDays = Number(input.expires_in_days ?? input.expiresInDays)
  const explicitTtl = Number.isFinite(expiresDays) && expiresDays > 0
  // 模型没传时，保守地从文本推断（可用 autoTtl:false 关闭）
  const autoDays = !explicitTtl && input.autoTtl !== false ? inferTtlDays(text) : 0
  const effDays = explicitTtl ? expiresDays : autoDays
  const expiresAt = effDays > 0 ? now + effDays * 86400000 : undefined

  const exact = store.memories.find((m) => m.text.toLowerCase() === text.toLowerCase() && (m.project || '') === project)
  if (exact) {
    if (exact.archived || (exact.expiresAt && exact.expiresAt <= now)) {
      const before = { ...exact }
      delete exact.archived
      if (expiresAt) exact.expiresAt = expiresAt
      else delete exact.expiresAt
      exact.importance = Math.max(exact.importance, importance)
      exact.updatedAt = now
      pushLog(store, 'update', [before], { ...exact }, 'unarchive-exact')
      touch(store)
    }
    return { item: exact, merged: false, deduped: true, related: [] }
  }

  if (input.replaces) {
    const target = store.memories.find((m) => m.id === input.replaces)
    if (target) {
      const b = { ...target, ...(target.history ? { history: [...target.history] } : {}) }
      const prevText = target.text
      const prevAt = target.updatedAt || target.createdAt
      target.text = text
      recordHistory(target, prevText, prevAt)
      if (input.category) target.category = category
      target.importance = Math.max(target.importance, importance)
      if (expiresAt) target.expiresAt = expiresAt
      delete target.archived
      target.updatedAt = now
      pushLog(store, 'update', [b], { ...target }, `replaces ${input.replaces}`)
      touch(store)
      return { item: target, merged: true, deduped: false, related: [] }
    }
  }

  let best = null, bestScore = 0
  const related = []
  for (const m of store.memories) {
    if (m.category !== category) continue
    if ((m.project || '') !== project) continue
    const sim = jaccard(m.text, text)
    if (sim > bestScore) { bestScore = sim; best = m }
    if (isLive(m, now) && sim >= CONFLICT_MIN_SIMILARITY && sim < MERGE_SIMILARITY) {
      related.push({ id: m.id, text: m.text, similarity: Number(sim.toFixed(2)) })
    }
  }
  if (best && bestScore >= MERGE_SIMILARITY) {
    const before = { ...best, ...(best.history ? { history: [...best.history] } : {}) }
    const prevText = best.text
    const prevAt = best.updatedAt || best.createdAt
    best.text = text
    recordHistory(best, prevText, prevAt)
    best.importance = Math.max(best.importance, importance)
    if (expiresAt) best.expiresAt = expiresAt
    delete best.archived
    best.updatedAt = now
    pushLog(store, 'merge', [before], { ...best }, `similarity ${bestScore.toFixed(2)}`)
    touch(store)
    return { item: best, merged: true, deduped: false, related: [] }
  }

  const item = {
    id: newId(), text, category, project, importance,
    source: input.source || { kind: 'agent' },
    createdAt: now, updatedAt: now, accessCount: 0, lastAccessedAt: 0,
    ...(expiresAt ? { expiresAt } : {}),
  }
  store.memories.push(item)
  enforceMaxMemories(store)
  pushLog(store, 'remember', [], { ...item }, 'new')
  touch(store)
  related.sort((a, b) => b.similarity - a.similarity)
  return { item, merged: false, deduped: false, related: related.slice(0, 3) }
}

export function recall(store, query, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 8))
  const project = opts.project || ''
  const category = opts.category || ''
  const now = Date.now()
  const pool = store.memories.filter((m) =>
    isLive(m, now) && projectMatches(m, project) && (!category || m.category === category))
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
  const before = { ...item, ...(item.history ? { history: [...item.history] } : {}) }
  if (text) {
    const newText = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    const prevText = item.text
    const prevAt = item.updatedAt || item.createdAt
    item.text = newText
    recordHistory(item, prevText, prevAt)
  }
  if (importance != null) item.importance = Math.max(1, Math.min(5, Number(importance) || item.importance))
  if (category && CATEGORIES.includes(category)) item.category = category
  if (project != null) item.project = String(project).trim()
  item.updatedAt = Date.now()
  pushLog(store, 'update', [before], { ...item }, '')
  touch(store)
  return item
}

/** 整理: 合并近重复 + 删除空条目。只做「代码能确定判断」的事，不发明事实。 */
export function consolidate(store, { skipLog = false } = {}) {
  let merged = 0, dropped = 0
  const snapshotBefore = store.memories.map((m) => ({ ...m, ...(m.history ? { history: [...m.history] } : {}) }))
  const before = store.memories.length
  store.memories = store.memories.filter((m) => m.text && m.text.trim())
  dropped += before - store.memories.length
  const kept = []
  for (const m of store.memories) {
    let absorbed = false
    for (const k of kept) {
      if (k.category !== m.category || (k.project || '') !== (m.project || '')) continue
      if (Boolean(k.archived) !== Boolean(m.archived)) continue
      if (jaccard(k.text, m.text) >= 0.72) {
        if (m.text.length > k.text.length) {
          const prevText = k.text
          k.text = m.text
          recordHistory(k, prevText, k.updatedAt)
        }
        k.importance = Math.max(k.importance, m.importance)
        k.updatedAt = Math.max(k.updatedAt, m.updatedAt)
        merged++
        absorbed = true
        break
      }
    }
    if (!absorbed) kept.push(m)
  }
  store.memories = kept
  if (!skipLog && (merged > 0 || dropped > 0)) {
    pushLog(store, 'consolidate-merge', snapshotBefore, null, `merged:${merged},dropped:${dropped}`)
  }
  touch(store)
  return { merged, dropped, total: store.memories.filter((m) => isLive(m)).length }
}

/** 归档已到期 (TTL) 或陈旧、低价值、长期未访问的记忆 (dream 的一部分，可撤销)。 */
export function archiveStale(store, days, { skipLog = false } = {}) {
  const now = Date.now()
  let archived = 0
  const archivedBefore = []
  for (const m of store.memories) {
    if (m.archived) continue
    // 1. 显式设置了 expiresAt 且已到期的短期情境记忆，无论重要度均归档
    if (m.expiresAt && m.expiresAt <= now) {
      archivedBefore.push({ ...m, archived: false })
      m.archived = true
      archived++
      continue
    }
    // 2. 常规陈旧低价值归档
    if (!(days > 0)) continue
    if (m.importance >= 3) continue                       // 高价值不归档
    const cutoff = now - days * 86400000
    const last = Math.max(m.lastAccessedAt || 0, m.updatedAt || 0, m.createdAt || 0)
    if ((m.accessCount || 0) === 0 && last < cutoff) {
      archivedBefore.push({ ...m, archived: false })
      m.archived = true
      archived++
    }
  }
  if (!skipLog && archivedBefore.length > 0) {
    pushLog(store, 'archive', archivedBefore, null, `stale > ${days}d`)
  }
  if (archived > 0) touch(store)
  return { archived }
}

/** dream: 整理 + 归档，返回报告（单次原子日志，可一键完整撤销）。 */
export function dream(store, config) {
  const days = config?.dream?.archiveAfterDays ?? config?.decayDays ?? DREAM_DEFAULTS.archiveAfterDays
  const snapshotBefore = store.memories.map((m) => ({ ...m, ...(m.history ? { history: [...m.history] } : {}) }))
  const c = consolidate(store, { skipLog: true })
  const a = archiveStale(store, days, { skipLog: true })
  if (c.merged > 0 || c.dropped > 0 || a.archived > 0) {
    pushLog(store, 'dream', snapshotBefore, null, `merged:${c.merged},dropped:${c.dropped},archived:${a.archived}`)
  }
  store.lastDreamAt = Date.now()
  store.dreams = (store.dreams || 0) + 1
  const total = store.memories.filter((m) => isLive(m)).length
  return { merged: c.merged, dropped: c.dropped, archived: a.archived, total }
}

export function undo(store) {
  const last = store.log.pop()
  if (!last) return { undone: false }
  if (last.action === 'dream' && Array.isArray(last.before)) {
    store.memories = last.before.map((m) => ({ ...m }))
  } else if (last.action === 'remember' && last.after?.id) {
    const i = store.memories.findIndex((x) => x.id === last.after.id)
    if (i >= 0) store.memories.splice(i, 1)
  } else if (last.action === 'forget' || last.action === 'consolidate-merge' || last.action === 'archive') {
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

// ---------------------------------------------------------------------------
// 注入：个性化画像 (关于你) + 避坑准则 + 近期情境 + 核心 + 最近 + 使用提示
// ---------------------------------------------------------------------------

function relTime(ts) {
  const d = Math.max(0, Math.floor((Date.now() - ts) / 86400000))
  if (d === 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

function line(m) {
  const proj = m.project ? ` [${m.project}]` : ''
  const prev = Array.isArray(m.history) && m.history.length > 0 ? ` (曾: ${m.history[m.history.length - 1].text})` : ''
  const exp = m.expiresAt ? ` [至 ${new Date(m.expiresAt).toISOString().slice(0, 10)}]` : ''
  return `- ${m.text}${prev}${proj}${exp} · ${relTime(m.updatedAt || m.createdAt)}`
}

/** 个性化画像：身份 + 偏好 (就是「关于你」)。 */
export function profileOf(store) {
  const now = Date.now()
  const live = store.memories.filter((m) => isLive(m, now))
  const identity = live.filter((m) => m.category === 'identity').sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
  const pref = live.filter((m) => m.category === 'preference').sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
  return { identity, preference: pref }
}

/** 组装要注入的系统提示词上下文 (agent-loop 会记进日志，满足 Model-visible ⩵ logged)。 */
export function buildInjection(store) {
  const now = Date.now()
  const live = store.memories.filter((m) => isLive(m, now))
  if (live.length === 0) {
    return [
      '## 你的个人记忆',
      '你拥有一份关于这个人的长期记忆，目前还是空的。',
      '当对方告诉你关于他自己的长期事实 (偏好、姓名、习惯、约束、决定) 时，用 `memory_remember` 记下来，这样你下次就知道。',
      '若是短期状态（这周、出差、这几天、临时、为期 N 天），必须设 `expires_in_days`，否则会被当成永久事实。',
    ].join('\n')
  }

  const { identity, preference } = profileOf(store)
  const lessons = live
    .filter((m) => m.category === 'lesson')
    .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
    .slice(0, 5)
  const core = live
    .filter((m) => m.importance >= CORE_IMPORTANCE)
    .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
    .slice(0, INJECT_CORE_MAX)
  const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, INJECT_RECENT_MAX)

  const out = ['## 你的个人记忆']
  const topIdentity = identity.slice(0, 6)
  const topPref = preference.slice(0, 10 - topIdentity.length)
  const restIdentity = identity.slice(topIdentity.length, 10 - topPref.length)
  const shownAbout = [...topIdentity, ...restIdentity, ...topPref].slice(0, 10)

  if (shownAbout.length) {
    out.push('### 关于你')
    for (const m of shownAbout) out.push(line(m))
  }

  const seen = new Set(shownAbout.map((m) => m.id))

  if (lessons.length) {
    out.push('### 经验与避坑准则')
    for (const m of lessons) { seen.add(m.id); out.push(line(m)) }
  }

  const others = [...core, ...recent].filter((m) => !seen.has(m.id))
  if (others.length) {
    out.push('### 其他记住的')
    for (const m of others) { if (seen.has(m.id)) continue; seen.add(m.id); out.push(line(m)) }
  }

  out.push('', `(共保留 ${live.length} 条记忆) `)
  out.push('(在回答可能依赖「你已知的大于对方的信息」的问题前，先用 `memory_recall` 检索；',
    '对方告诉你长期事实时用 `memory_remember` 记下（短期状态如出差/这周/这几天，必须设 `expires_in_days`）；对方要你忘记时用 `memory_forget`。)')
  return out.join('\n')
}

/** 导出人类可读的 Markdown 个人记忆档案。 */
export function exportMarkdown(store) {
  const now = Date.now()
  const live = store.memories.filter((m) => isLive(m, now))
  if (!live.length) return '# 个人记忆档案\n\n> 暂无活跃记忆。\n'
  const out = ['# 个人记忆档案 (jt-da-pa-memory)', '']
  const byCat = new Map()
  for (const c of CATEGORIES) byCat.set(c, [])
  for (const m of live) {
    const list = byCat.get(m.category) || byCat.get('other')
    list.push(m)
  }
  const labels = {
    identity: '身份 (Identity)',
    preference: '偏好与习惯 (Preference)',
    lesson: '经验与避坑准则 (Lesson)',
    goal: '目标与计划 (Goal)',
    project: '项目上下文 (Project)',
    fact: '长期事实 (Fact)',
    other: '其他 (Other)',
  }
  for (const [cat, items] of byCat) {
    if (!items.length) continue
    items.sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
    out.push(`## ${labels[cat] || cat}`)
    for (const m of items) out.push(`${line(m)} \`[${m.id}]\``)
    out.push('')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 工具定义 (原始 ToolDefinition，零依赖)
// ---------------------------------------------------------------------------

const textBlock = (text) => [{ type: 'text', text }]

function tool(name, description, parameters, schema, execute, render, presentCall) {
  return {
    name, description, parameters,
    output: { schema, render: render || ((_a, v) => textBlock(typeof v === 'string' ? v : JSON.stringify(v, null, 2))) },
    async execute(args, exec) { return execute(args || {}, exec) },
    ...(presentCall ? { presentCall } : {}),
  }
}

function buildTools(store, save, sync, ctx, scheduleRef, cfg) {
  return [
    tool(
      'memory_remember',
      '记住关于这个人的长期事实，供以后的每次对话使用：偏好、姓名、习惯、约束、决定。一句话。当对方说了你下次应该知道的事情时使用。事实发生变化时，用 `replaces` 传入已有条目的 id 来更新，而不是新增第二条。【重要】若是短期状态（出差、这周、这几天、临时、为期一周等），必须设 `expires_in_days`，否则它会被当成永久事实、长期污染上下文。绝不要密码或支付信息。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', description: '事实，一句话，最多 400 字。' },
          category: { type: 'string', enum: CATEGORIES, description: 'identity | preference | fact | project | lesson | goal | other' },
          importance: { type: 'integer', minimum: 1, maximum: 5, description: '1-5；3 及以上会始终保留在上下文中。默认 3。' },
          project: { type: 'string', description: '可选的项目/工作区名；留空表示全局。' },
          replaces: { type: 'string', description: '要更新的旧记忆 id (事实变了时用，会自动保留变更历史)。' },
          expires_in_days: { type: 'number', description: '可选：几天后自动过期归档（用于短期出差、阶段性状态等情境记忆）。' },
        },
        required: ['text'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          merged: { type: 'boolean' },
          related: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, similarity: { type: 'number' } } } },
        },
      },
      (args) => {
        sync()
        const r = remember(store, { ...args, autoTtl: cfg.autoTtl })
        save()
        return { id: r.item.id, text: r.item.text, merged: r.merged || r.deduped, related: r.related || [] }
      },
      (_a, v) => {
        const base = `${v.merged ? '已更新' : '已记住'}:${v.text} (${v.id}) `
        if (v.related && v.related.length) {
          const hints = v.related.map((x) => `「${x.text}」(${x.id})`).join('、')
          return textBlock(`${base}\n提示：发现同类别相似记忆 ${hints}，若事实已变更可用 replaces 更新或 memory_forget 清理旧条目。`)
        }
        return textBlock(base)
      },
    ),

    tool(
      'memory_recall',
      '在你的长期记忆中检索与 `query` 相关的事实。在回答任何可能依赖「你已知的大于对方的信息」的问题之前，先调用它。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要找什么。' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回条数，1-50。默认 8。' },
          category: { type: 'string', enum: CATEGORIES, description: '限定某一类别。' },
          project: { type: 'string', description: '限定某个项目 (含全局)。' },
        },
        required: ['query'],
      },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
      (args) => {
        sync()
        const items = recall(store, args.query, args)
        for (const m of items) { m.accessCount = (m.accessCount || 0) + 1; m.lastAccessedAt = Date.now() }
        if (items.length > 0) save()
        return items.map((m) => ({ id: m.id, text: m.text }))
      },
      (_a, v) => textBlock(v.length ? v.map((m) => `- ${m.text} (${m.id})`).join('\n') : '没有匹配的记忆。'),
    ),

    tool(
      'memory_forget',
      '删除关于这个人的记忆。给 `id` 删一条，给 `query` 删掉所有包含该文字的记忆。对方要求忘记某事时使用。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '要删除的记忆 id。' }, query: { type: 'string', description: '删除所有包含该文字的记忆。' } } },
      { type: 'object', additionalProperties: false, properties: { removed: { type: 'integer' } } },
      (args) => { sync(); const r = forget(store, args); save(); return r },
      (_a, v) => textBlock(v.removed ? `已忘记 ${v.removed} 条记忆。` : '没有匹配。'),
    ),

    tool(
      'memory_update',
      '按 id 修改一条已有记忆：文字、类别、重要性或项目。用来修正错误或过时的事实。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要修改的记忆 id。' },
          text: { type: 'string', description: '新的文字。' },
          category: { type: 'string', enum: CATEGORIES, description: '新的类别。' },
          importance: { type: 'integer', minimum: 1, maximum: 5, description: '新的重要性 1-5。' },
          project: { type: 'string', description: '新的项目归属。' },
        },
        required: ['id'],
      },
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' } } },
      (args) => { sync(); const it = update(store, args); save(); return it ? { id: it.id, text: it.text } : { id: '', text: '' } },
      (_a, v) => textBlock(v.id ? `已更新 ${v.id}:${v.text}` : '没有该 id 的记忆。'),
    ),

    tool(
      'memory_list',
      '列出你记得的关于这个人的全部内容，可按类别过滤。对方问「你知道我什么」时使用。',
      { type: 'object', additionalProperties: false, properties: { category: { type: 'string', enum: CATEGORIES, description: '只列某一类别。' }, limit: { type: 'integer', description: '最多列几条，默认 60。' } } },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, category: { type: 'string' } } } },
      (args) => {
        sync()
        const now = Date.now()
        const limit = Math.max(1, Math.min(200, Number(args.limit) || 60))
        return store.memories
          .filter((m) => isLive(m, now) && (!args.category || m.category === args.category))
          .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
          .slice(0, limit)
          .map((m) => ({ id: m.id, text: m.text, category: m.category }))
      },
      (_a, v) => textBlock(v.length ? v.map((m) => `- (${m.category}) ${m.text} (${m.id})`).join('\n') : '还没有记住任何东西。'),
    ),

    tool(
      'memory_profile',
      '读取你对这个人的「个性化画像」：身份与偏好。当你想快速确认对方是谁、喜欢怎样被对待时使用。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { identity: { type: 'array' }, preference: { type: 'array' } } },
      () => {
        sync()
        const p = profileOf(store)
        return { identity: p.identity.map((m) => ({ id: m.id, text: m.text })), preference: p.preference.map((m) => ({ id: m.id, text: m.text })) }
      },
      (_a, v) => textBlock(
        [v.identity.length ? '关于你 (身份):\n' + v.identity.map((m) => `- ${m.text}`).join('\n') : ' (尚无身份信息)',
         v.preference.length ? '偏好:\n' + v.preference.map((m) => `- ${m.text}`).join('\n') : ' (尚无偏好)'].join('\n\n')),
    ),

    tool(
      'memory_remind',
      '安排一次「主动打扰」：到点由定时服务唤醒你，你主动去找用户说这件事。用于「提醒我……」「……的时候告诉我」「每天/每周……」这类请求。必须给出一个时间：after_seconds (几秒后) / every_seconds (周期秒数) / at (绝对时刻) / daily / weekly / cron 之一。',
      {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', description: '到点要主动告诉内容 (一句话)。' },
          title: { type: 'string', description: '提醒的名字，最多 120 字。缺省取 text 前 40 字。' },
          after_seconds: { type: 'integer', description: '多少秒后 (一次性)。' },
          every_seconds: { type: 'integer', description: '每隔多少秒重复一次 (周期性)。' },
          at: { type: 'string', description: '绝对时刻，ISO 字符串 (一次性)。' },
          daily: { type: 'object', description: '每日: { time: "HH:mm:ss", time_zone: "Asia/Shanghai" }' },
          weekly: { type: 'object', description: '每周: { time, time_zone, weekdays: [1..7] }' },
          cron: { type: 'object', description: 'cron: { expression, time_zone }' },
        },
        required: ['text'],
      },
      { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' }, error: { type: 'string' } } },
      async (args, exec) => {
        if (!cfg.proactive.enabled) {
          return { ok: false, id: '', title: '', error: '当前配置已禁用主动打扰 (proactive.enabled=false)。' }
        }
        const svc = scheduleRef.service
        if (!svc) return { ok: false, id: '', title: '', error: '此 profile 未启用定时服务 (dsh-schedule)，无法安排主动提醒。' }
        const sessionId = exec?.agent?.session?.id || exec?.session?.id
        if (!sessionId) return { ok: false, id: '', title: '', error: '无法确定当前会话。' }
        const rawTitle = String(args.title || args.text || '').trim()
        const prefixedTitle = rawTitle.startsWith('主动·') ? rawTitle.slice(0, 120) : ('主动·' + rawTitle.slice(0, 116))
        const req = { prompt: args.text, title: prefixedTitle }
        for (const k of TIME_SELECTOR_KEYS) if (args[k] != null) req[k] = args[k]
        if (!TIME_SELECTOR_KEYS.some((k) => req[k] != null)) {
          return { ok: false, id: '', title: '', error: '必须给出一个时间: after_seconds / every_seconds / at / daily / weekly / cron。' }
        }
        try {
          const rec = await svc.create(sessionId, req, exec?.signal)
          return { ok: true, id: String(rec.id), title: String(rec.title || req.title), error: '' }
        } catch (e) {
          return { ok: false, id: '', title: '', error: '安排失败:' + (e && e.message ? e.message : String(e)) }
        }
      },
      (_a, v) => textBlock(v.ok ? `已安排主动提醒「${v.title}」(${v.id})。到点我会主动找你。` : v.error),
      (args) => ({ card: 'generic', title: `主动提醒：${(args.text || '').slice(0, 40)}`, kind: 'other', rawInput: args }),
    ),

    tool(
      'memory_reminders',
      '列出本会话已安排的主动提醒。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
      async (_args, exec) => {
        const svc = scheduleRef.service
        const sessionId = exec?.agent?.session?.id || exec?.session?.id
        if (!svc || !sessionId) return []
        try {
          const list = await svc.list({ sessionId })
          return (list || []).map((r) => ({ id: String(r.id), title: String(r.title || '') }))
        } catch { return [] }
      },
      (_a, v) => textBlock(v.length ? v.map((r) => `- ${r.title} (${r.id})`).join('\n') : '本会话没有已安排的提醒。'),
    ),

    tool(
      'memory_cancel_reminder',
      '按 id 取消一条本会话已安排的主动提醒。',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: '要取消的提醒 id。' } }, required: ['id'] },
      { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      async (args, exec) => {
        const svc = scheduleRef.service
        const sessionId = exec?.agent?.session?.id || exec?.session?.id
        if (!svc || !sessionId) return { ok: false, error: '定时服务或会话不可用。' }
        try { await svc.delete({ sessionId, id: args.id }, exec?.signal); return { ok: true, error: '' } }
        catch (e) { return { ok: false, error: '取消失败:' + (e && e.message ? e.message : String(e)) } }
      },
      (_a, v) => textBlock(v.ok ? '已取消该提醒。' : v.error),
    ),

    tool(
      'memory_dream',
      '手动整理记忆：合并近重复、删除空条目、归档陈旧低价值条目。可用 memory_undo 撤销。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { merged: { type: 'integer' }, dropped: { type: 'integer' }, archived: { type: 'integer' }, total: { type: 'integer' } } },
      () => { sync(); const r = dream(store, cfg); save(); return r },
      (_a, v) => textBlock(`记忆已整理：合并 ${v.merged} 条，删除 ${v.dropped} 条，归档 ${v.archived} 条；保留 ${v.total} 条。`),
    ),

    tool(
      'memory_undo',
      '撤销最近一次记忆改动 (新增、遗忘、合并、归档或编辑)。',
      { type: 'object', additionalProperties: false, properties: {} },
      { type: 'object', additionalProperties: false, properties: { undone: { type: 'boolean' }, action: { type: 'string' } } },
      () => { sync(); const r = undo(store); save(); return { undone: r.undone, action: r.action || '' } },
      (_a, v) => textBlock(v.undone ? `已撤销:${v.action}。` : '没有可撤销的改动。'),
    ),
  ]
}

// ---------------------------------------------------------------------------
// 人类命令: /memory 与 /dream (不经模型)
// ---------------------------------------------------------------------------

const MEMORY_HELP = [
  'jt-da-pa 记忆命令:',
  '  /memory                 列出全部记忆',
  '  /memory forget <文字>    删除所有包含该文字的记忆',
  '  /memory forget id:<id>  按 id 删除一条',
  '  /memory undo            撤销最近一次新增/删除/合并/归档',
  '  /memory tidy            整理 (同 dream)',
  '  /memory profile         只看【关于你】画像',
  '  /memory export          导出 Markdown 格式的完整记忆档案',
  '  /profile                同上 (单独命令)',
  '  /dream                  手动整理记忆',
  '  /memory help            显示本帮助',
  '',
  '记忆文件: $DSH_HOME/jt-da-pa-memory/memory.json (可直接编辑，支持热同步)',
].join('\n')

export function commandList(store) {
  const now = Date.now()
  const live = store.memories.filter((m) => isLive(m, now))
  if (!live.length) return '你的记忆还是空的。当你说到关于自己的长期事实时，我会记下来。'
  const { identity, preference } = profileOf(store)
  const out = [`你的个人记忆 (共 ${live.length} 条):`]
  const about = [...identity, ...preference]
  if (about.length) {
    out.push('【关于你】')
    for (const m of about) {
      const prev = Array.isArray(m.history) && m.history.length ? ` (曾: ${m.history[m.history.length - 1].text})` : ''
      out.push(`  ${m.text}${prev}  [${m.id}]`)
    }
  }
  const others = live.filter((m) => !about.includes(m))
  if (others.length) {
    out.push('【其他】')
    for (const m of others.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const prev = Array.isArray(m.history) && m.history.length ? ` (曾: ${m.history[m.history.length - 1].text})` : ''
      out.push(`  (${m.category}) ${m.text}${prev} · ${relTime(m.updatedAt)}  [${m.id}]`)
    }
  }
  const archived = store.memories.filter((m) => !isLive(m, now)).length
  if (archived) out.push('', ` (另有 ${archived} 条已归档/已过期)`)
  out.push('', '删除: /memory forget <文字>   或   /memory forget id:<id>')
  return out.join('\n')
}

export function memoryCommandDefinition(store, save, cfg, sync = () => {}) {
  return {
    name: 'memory',
    description: '查看 / 删除 / 整理 / 导出 jt-da-pa 的个人记忆',
    input: { hint: '[list | forget <文字|id:xxx> | undo | tidy | profile | export | help]' },
    handler({ rawInput }) {
      try {
        sync()
        const input = String(rawInput || '').trim()
        const mm = /^(\S+)?\s*([\s\S]*)$/.exec(input)
        const verb = (mm?.[1] || 'list').toLowerCase()
        const arg = (mm?.[2] || '').trim()
        if (verb === 'list') return { kind: 'success', text: commandList(store) }
        if (verb === 'help') return { kind: 'success', text: MEMORY_HELP }
        if (verb === 'export') return { kind: 'success', text: exportMarkdown(store) }
        if (verb === 'forget') {
          if (!arg) return { kind: 'error', text: '用法: /memory forget <文字>  或  /memory forget id:<id>' }
          if (arg.startsWith('id:')) {
            const id = arg.slice(3).trim()
            const r = forget(store, { id }); save()
            return r.removed ? { kind: 'success', text: `已删除记忆 ${id}。可用 /memory undo 撤销。` } : { kind: 'error', text: `没有 id 为 ${id} 的记忆。` }
          }
          const r = forget(store, { query: arg }); save()
          return r.removed ? { kind: 'success', text: `已删除 ${r.removed} 条包含「${arg}」的记忆。可用 /memory undo 撤销。` } : { kind: 'error', text: `没有包含「${arg}」的记忆。` }
        }
        if (verb === 'undo') { const r = undo(store); save(); return r.undone ? { kind: 'success', text: `已撤销:${r.action}。` } : { kind: 'error', text: '没有可撤销的改动。' } }
        if (verb === 'tidy') { const r = dream(store, cfg); save(); return { kind: 'success', text: `记忆已整理：合并 ${r.merged}, 删除 ${r.dropped}, 归档 ${r.archived}；保留 ${r.total}。` } }
        if (verb === 'profile') return { kind: 'success', text: commandProfile(store) }
        return { kind: 'error', text: `未知子命令:${verb}\n\n${MEMORY_HELP}` }
      } catch (e) { return { kind: 'error', text: '记忆命令出错:' + (e && e.message ? e.message : String(e)) } }
    },
  }
}

export function commandProfile(store) {
  const { identity, preference } = profileOf(store)
  if (!identity.length && !preference.length) {
    return [
      '还没有形成你的个人画像。',
      '当你说到关于自己的事 (名字、身份、偏好、习惯) 时，我会记下来，例如:',
      '  - 记住我叫小蓝，身份是后端工程师',
      '  - 记住我喜欢简短直接的回答',
      '这些会归到 identity / preference，作为【关于你】每轮注入。',
    ].join('\n')
  }
  const out = ['【关于你】—— 我记住的你的画像:']
  if (identity.length) {
    out.push('身份:')
    for (const m of identity) {
      const prev = Array.isArray(m.history) && m.history.length ? ` (曾: ${m.history[m.history.length - 1].text})` : ''
      out.push(`  - ${m.text}${prev}  [${m.id}]`)
    }
  }
  if (preference.length) {
    out.push('偏好与习惯:')
    for (const m of preference) {
      const prev = Array.isArray(m.history) && m.history.length ? ` (曾: ${m.history[m.history.length - 1].text})` : ''
      out.push(`  - ${m.text}${prev}  [${m.id}]`)
    }
  }
  out.push('', '修改: /memory forget id:<id> 删除，或直接说「记住……」。')
  return out.join('\n')
}

/** 构造 /profile 命令 (只看画像)。 */
export function profileCommandDefinition(store, save, sync = () => {}) {
  return {
    name: 'profile',
    description: '查看 jt-da-pa 记住的「关于你」个性化画像 (身份 + 偏好)',
    handler() { try { sync(); return { kind: 'success', text: commandProfile(store) } } catch (e) { return { kind: 'error', text: '读取画像出错:' + (e && e.message ? e.message : String(e)) } } },
  }
}

export function dreamCommandDefinition(store, save, cfg, sync = () => {}) {
  return {
    name: 'dream',
    description: '手动整理 jt-da-pa 的记忆 (dream)：合并近重复、删空、归档陈旧条目',
    handler() {
      try { sync(); const r = dream(store, cfg); save(); return { kind: 'success', text: `🧠 dream 完成：合并 ${r.merged}, 删除 ${r.dropped}, 归档 ${r.archived}；保留 ${r.total}。` } }
      catch (e) { return { kind: 'error', text: 'dream 失败:' + (e && e.message ? e.message : String(e)) } }
    },
  }
}

// ---------------------------------------------------------------------------
// Web UI：宿主 HTTP 接口（ctx.webServer，可选）+ 独立页面
// ---------------------------------------------------------------------------

/** 接口与页面的挂载前缀。 */
export const UI_PREFIX = '/jt-da-pa-memory'

/** 读取一个 JSON 请求体（失败/超限都返回空对象，不抛）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** 暴露给前端的字段（不含内部日志类字段）。 */
function publicMemory(m) {
  return { id: m.id, text: m.text, category: m.category, project: m.project || '', importance: m.importance, expiresAt: m.expiresAt || 0, archived: !!m.archived, updatedAt: m.updatedAt }
}

/** 构造宿主的 HTTP 处理器：一个 prefix 路由内部再分发。 */
export function webHandlerFor(store, save, sync) {
  return async (req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname
    try {
      sync()
      if (p === UI_PREFIX || p === UI_PREFIX + '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(memoryPage())
        return
      }
      if (p === UI_PREFIX + '/api/list') { sendJson(res, 200, { memories: store.memories.map(publicMemory) }); return }
      if (p === UI_PREFIX + '/api/forget') { const b = await readBody(req); const r = forget(store, { id: b.id, query: b.query }); save(); sendJson(res, 200, r); return }
      if (p === UI_PREFIX + '/api/update') { const b = await readBody(req); const it = update(store, b); save(); sendJson(res, 200, it ? publicMemory(it) : {}); return }
      if (p === UI_PREFIX + '/api/add') { const b = await readBody(req); const r = remember(store, { text: b.text, category: b.category, importance: b.importance, project: b.project, expires_in_days: b.expires_in_days, source: { kind: 'person' } }); save(); sendJson(res, 200, publicMemory(r.item)); return }
      if (p === UI_PREFIX + '/api/undo') { const r = undo(store); save(); sendJson(res, 200, r); return }
      sendJson(res, 404, { error: 'not_found' })
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) })
    }
  }
}

/** 独立页面：打开 http://127.0.0.1:<port>/jt-da-pa-memory/ 就能看/删记忆。 */
export function memoryPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jt-da-pa 记忆</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#f6f7fb;color:#1c1f2a}
main{max-width:820px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#5a6070;font-size:13px;margin-bottom:18px}
.add{display:flex;gap:8px;margin-bottom:20px}
.add input{flex:1}
input,select,button{font:inherit;border:1px solid #cdd2de;border-radius:8px;padding:6px 10px;background:#fff;color:inherit}
button{cursor:pointer}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5a6070;margin:22px 0 8px}
ul{list-style:none;padding:0;margin:0}
li{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fff;border:1px solid #e3e6ee;border-radius:10px;margin-bottom:6px}
.t{flex:1}.id{font:11px ui-monospace,monospace;color:#8b91a1}
.exp{font-size:11px;color:#c47f00}.arch{opacity:.45;text-decoration:line-through}
.del{color:#d23b3b;border-color:#f3c7c7}
footer{margin-top:28px;color:#8b91a1;font-size:12px}
</style></head><body><main>
<h1>jt-da-pa 记忆</h1><div class="sub" id="sub">加载中…</div>
<div class="add"><input type="text" id="new" placeholder="手动记一条…（回车）"><button id="addBtn">记住</button><button id="undoBtn" title="撤销最近一次删除/合并">撤销</button></div>
<div id="list"></div>
<footer>直接读写 $DSH_HOME/jt-da-pa-memory/memory.json。删除即刻生效，点“撤销”可回退。</footer>
</main><script>
var CATS=['identity','preference','fact','project','lesson','goal','other'];
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(p,b){return fetch('/jt-da-pa-memory/api/'+p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:undefined).then(function(r){return r.json()})}
function load(){api('list').then(function(d){render(d.memories||[])})}
function render(items){
  document.getElementById('sub').textContent='共 '+items.length+' 条';
  var groups={};items.forEach(function(m){(groups[m.category]=groups[m.category]||[]).push(m)});
  var order=CATS.concat(Object.keys(groups).filter(function(c){return CATS.indexOf(c)<0}));
  var html='';order.forEach(function(cat){
    var arr=groups[cat];if(!arr||!arr.length)return;
    html+='<h3>'+esc(cat)+'</h3><ul>';
    arr.forEach(function(m){
      var exp=m.expiresAt?'<span class="exp">[至 '+new Date(m.expiresAt).toISOString().slice(0,10)+']</span>':'';
      html+='<li><span class="t'+(m.archived?' arch':'')+'">'+esc(m.text)+'</span>'+exp+'<span class="id">'+m.id+'</span><button class="del" data-id="'+m.id+'">删除</button></li>';
    });
    html+='</ul>';
  });
  document.getElementById('list').innerHTML=html;
  Array.prototype.forEach.call(document.querySelectorAll('.del'),function(b){b.onclick=function(){api('forget',{id:b.getAttribute('data-id')}).then(load)}});
}
document.getElementById('addBtn').onclick=function(){var v=document.getElementById('new').value.trim();if(!v)return;api('add',{text:v}).then(function(){document.getElementById('new').value='';load()})};
document.getElementById('new').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('addBtn').click()});
document.getElementById('undoBtn').onclick=function(){api('undo',{}).then(load)};
load();
</script></body></html>`
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export const name = 'jt-da-pa-memory'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const file = storePath(cfg)
  const store = loadStore(file)
  const sync = () => syncStoreFromDisk(file, store)
  const save = () => { try { saveStore(file, store) } catch (e) { safeLog(ctx, 'save failed: ' + (e && e.message)) } }

  // 可选服务引用 (schedule 用于主动打扰；缺席时相关工具返回明确错误)
  const scheduleRef = { service: null }
  ctx.inject(['schedule'], (sctx) => { scheduleRef.service = sctx.schedule })

  // 1) 工具
  for (const t of buildTools(store, save, sync, ctx, scheduleRef, cfg)) {
    ctx.effect(() => ctx.tools.register(t), `jt-da-pa-memory: ${t.name}`)
  }

  // 2) 系统提示词上下文 (个性化画像 + 避坑准则 + 核心 + 最近)
  ctx.inject(['systemPrompt'], (sysCtx) => {
    ctx.effect(
      () => sysCtx.systemPrompt.context({
        name: 'jt-da-pa-memory',
        order: 45,
        text: () => { try { sync(); return buildInjection(store) } catch { return '' } },
      }),
      'jt-da-pa-memory: prompt context',
    )
  })

  // 3) 人类命令 /memory、/profile、/dream
  ctx.inject(['commands'], (cmdCtx) => {
    ctx.effect(() => cmdCtx.commands.register(memoryCommandDefinition(store, save, cfg, sync)), 'jt-da-pa-memory: /memory')
    ctx.effect(() => cmdCtx.commands.register(profileCommandDefinition(store, save, sync)), 'jt-da-pa-memory: /profile')
    ctx.effect(() => cmdCtx.commands.register(dreamCommandDefinition(store, save, cfg, sync)), 'jt-da-pa-memory: /dream')
  })

  // 4) dream 空闲整理 (每 60s 检查一次；空闲 ≥ idleMinutes 且自上次 dream 后有过写入)
  if (cfg.dream.enabled) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          sync()
          const now = Date.now()
          const lastWrite = store.lastWriteAt || 0
          const lastDream = store.lastDreamAt || 0
          if (lastWrite === 0) return                      // 从未写入，不 dream
          if (now - lastWrite < cfg.dream.idleMinutes * 60000) return   // 还不够空闲
          if (lastDream >= lastWrite) return               // 本次写入后已 dream 过
          const r = dream(store, cfg)
          save()
          safeLog(ctx, `dream (空闲 ${cfg.dream.idleMinutes} 分钟): ${JSON.stringify(r)}`)
        } catch (e) { safeLog(ctx, 'dream failed: ' + (e && e.message)) }
      }, 60000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'jt-da-pa-memory: dream timer')
  }

  // 5) Web UI：宿主接口 + 独立页面（webServer 可选，缺席则无 UI）
  ctx.inject(['webServer'], (wctx) => {
    ctx.effect(
      () => wctx.webServer.register({ kind: 'prefix', path: UI_PREFIX, handler: webHandlerFor(store, save, sync) }),
      'jt-da-pa-memory: web routes',
    )
  })

  safeLog(ctx, `已加载 ${store.memories.length} 条记忆 (${file}); dream=${cfg.dream.enabled ? '开' : '关'}, 主动打扰=${cfg.proactive.enabled ? '开' : '关'}`)
}

function safeLog(ctx, msg) {
  try { ctx.logger?.info?.(`jt-da-pa-memory: ${msg}`) } catch { /* ignore */ }
}
