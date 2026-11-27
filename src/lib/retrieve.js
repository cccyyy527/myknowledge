// 本地检索：把知识库挑出相关笔记、拼成能给模型看的「资料」
// 没有后端、没有向量库，纯字符 n-gram 打分，够用到几千篇
import { liveNotes, topicPath } from './store.js'

const MAX_NOTES = 10
const BUDGET = 18000 // 资料总字符上限，约 9k token

export function blockText(b) {
  if (!b) return ''
  if (b.type === 'image') return b.text || ''
  if (b.type === 'qa') return [b.question, b.answer].filter(Boolean).join(' ')
  if (b.type === 'pitfall') return [b.text, b.cause, b.avoid].filter(Boolean).join(' ')
  if (b.type === 'comparison')
    return [b.left, b.right, (b.rows || []).map((r) => `${r.k}:${r.a}/${r.b}`).join(' ')]
      .filter(Boolean)
      .join(' ')
  return [b.text, b.term, b.detail, b.latex, (b.items || []).join(' ')].filter(Boolean).join(' ')
}

// 中文按二元组切，拉丁按单词切：中文没分词也能召回
export function tokenize(q) {
  const s = String(q || '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    if (m[0].length >= 2) out.add(m[0])
  }
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

const titleOf = (n) => String(n.title || '').toLowerCase()
const pathOf = (n) => topicPath(n.topicId).map((t) => t.name).join(' ').toLowerCase()
const bodyOf = (n) => (n.blocks || []).map(blockText).join('\n').toLowerCase()

// 命中次数封顶，防止「的」这类高频组词把分数拉爆
function hits(hay, term, cap = 5) {
  let n = 0
  let i = -1
  while ((i = hay.indexOf(term, i + 1)) !== -1 && n < cap) n++
  return n
}

function scoreNote(note, toks, phrase, softToks = []) {
  const title = titleOf(note)
  const path = pathOf(note)
  const body = bodyOf(note)
  let score = 0
  for (const t of toks) {
    if (title.includes(t)) score += 6
    if (path.includes(t)) score += 3
    score += hits(body, t)
  }
  // 追问带上的上一轮问题只算半票：别让「上轮聊过的话题」盖过「这一句真正问的」
  for (const t of softToks) {
    if (title.includes(t)) score += 3
    if (path.includes(t)) score += 1.5
    score += hits(body, t) * 0.5
  }
  if (phrase) {
    if (title.includes(phrase)) score += 12
    if (body.includes(phrase)) score += 4
  }
  return score
}

// 只有小节标题、正文一个字都没有的笔记（建出来还没写的那种）
export const noteIsEmpty = (note) =>
  !(note.blocks || []).some((b) => b.type !== 'heading' && blockText(b).trim())

// 给模型看的正文：按小节分段，空笔记直接说清楚是空的，
// 免得模型把「标题占了关键词」当成「这篇里有内容」。
// ids 给 agent 的 read_note 用：每块前面标上块 id，改已有内容的提案要拿它当靶子。
export function noteText(note, { budget = 7000, ids = false } = {}) {
  const path = topicPath(note.topicId).map((t) => t.name).join(' / ')
  const lines = [`《${note.title}》　位置：${path || '未归类'}`]
  if (note.tags?.length) lines.push(`标签：${note.tags.join('、')}`)
  lines.push(`正文 ${(note.blocks || []).filter((b) => b.type !== 'heading').length} 块`)
  let sec = ''
  let wrote = false
  for (const b of note.blocks || []) {
    if (b.type === 'heading') {
      sec = b.text || ''
      if (ids) lines.push(`## ${sec}　[#${b.id}]`)
      continue
    }
    const t = blockText(b).trim()
    if (!t) continue
    wrote = true
    const at = sec ? `${b.type} · ${sec}` : b.type
    lines.push(ids ? `- [#${b.id}] (${at}) ${t}` : `- (${at}) ${t}`)
  }
  if (!wrote) lines.push('（这篇只有小节标题，正文还是空的）')
  const text = lines.join('\n')
  return text.length > budget ? `${text.slice(0, budget)}\n…（后面截掉了）` : text
}

// agent 的 search_notes 用：轻量摘要 + 是否空笔记
export function noteBrief(note, idx) {
  const path = topicPath(note.topicId).map((t) => t.name).join(' / ')
  const lead = (note.blocks || [])
    .filter((b) => b.type !== 'heading')
    .map((b) => blockText(b).trim())
    .find(Boolean) || ''
  return {
    id: note.id,
    title: note.title,
    path: path || '未归类',
    tags: note.tags || [],
    empty: noteIsEmpty(note),
    lead: lead.slice(0, 80),
    idx,
  }
}

// 和 searchLibrary 同一套打分，只是不设相对分下限：换成 agent 反复查，
// 漏召回比多召回贵得多
export function searchNotes(question, { limit = 6, extra = '' } = {}) {
  const phrase = String(question || '').trim().toLowerCase()
  const toks = tokenize(question)
  if (!toks.length && !phrase) return []
  const seen = new Set(toks)
  const softToks = tokenize(extra).filter((t) => !seen.has(t))
  return liveNotes()
    .map((note) => ({ note, score: scoreNote(note, toks, phrase, softToks) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((x, i) => noteBrief(x.note, i + 1))
}

function noteDigest(note, idx) {
  const head = [`[${idx}] 《${note.title}》　路径：${topicPath(note.topicId).map((t) => t.name).join(' / ') || '未归类'}`]
  const rest = noteText(note).split('\n').slice(1).join('\n')
  return `${head}\n${rest}`
}

const byUpdated = (a, b) =>
  (new Date(b.updatedAt || b.createdAt || 0).getTime() || 0) -
  (new Date(a.updatedAt || a.createdAt || 0).getTime() || 0)

// 命中的笔记 + 分数，给 UI 里「翻了哪几篇」用
// extra：追问时把上一轮的问题也拿来找，只算半票
export function searchLibrary(question, { limit = MAX_NOTES, extra = '' } = {}) {
  const phrase = String(question || '').trim().toLowerCase()
  const toks = tokenize(question)
  const seen = new Set(toks)
  const softToks = tokenize(extra).filter((t) => !seen.has(t))
  const ranked = liveNotes()
    .map((note) => ({ note, score: scoreNote(note, toks, phrase, softToks) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) return []
  // 只沾到「怎么」这种常见二字词也算命中，会把无关笔记全捞进来；
  // 用相对最高分的下限掐掉这种噪音
  const cut = Math.max(3, ranked[0].score * 0.1)
  return ranked.filter((x) => x.score >= cut).slice(0, limit)
}

// 组资料：优先命中，一篇都没命中就退回最近改的几篇，避免模型完全瞎猜
export function buildContext(question, { budget = BUDGET, extra = '' } = {}) {
  const notes = liveNotes().filter((n) => (n.blocks || []).length)
  if (!notes.length) return { empty: true, text: '', used: [] }

  let picked = searchLibrary(question, { extra })
  const fallback = picked.length === 0
  if (fallback) {
    picked = notes
      .slice()
      .sort(byUpdated)
      .slice(0, 6)
      .map((note) => ({ note, score: 0 }))
  }

  const used = []
  const chunks = []
  let size = 0
  for (const { note } of picked) {
    const d = noteDigest(note, used.length + 1)
    const over = size + d.length > budget
    if (over && used.length) break
    const piece = over ? d.slice(0, Math.max(0, budget - size)) : d
    chunks.push(piece)
    used.push({
      id: note.id,
      title: note.title,
      path: topicPath(note.topicId).map((t) => t.name).join(' / '),
    })
    size += piece.length
    if (over) break
  }
  return { empty: false, fallback, text: chunks.join('\n\n'), used }
}

export function libraryStats() {
  const notes = liveNotes().length
  const blocks = liveNotes().reduce(
    (s, n) => s + (n.blocks || []).filter((b) => b.type !== 'heading').length,
    0,
  )
  return { notes, blocks }
}
