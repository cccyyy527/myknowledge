// 本地检索：把知识库挑出相关笔记、拼成能给模型看的「资料」
// 没有后端、没有向量库，纯字符 n-gram 打分，够用到几千篇
import { state, topicPath } from './store.js'

const MAX_NOTES = 10
const BUDGET = 18000 // 资料总字符上限，约 9k token

export function blockText(b) {
  if (!b) return ''
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

function scoreNote(note, toks, phrase) {
  const title = titleOf(note)
  const path = pathOf(note)
  const body = bodyOf(note)
  let score = 0
  for (const t of toks) {
    if (title.includes(t)) score += 6
    if (path.includes(t)) score += 3
    score += hits(body, t)
  }
  if (phrase) {
    if (title.includes(phrase)) score += 12
    if (body.includes(phrase)) score += 4
  }
  return score
}

function noteDigest(note, idx) {
  const path = topicPath(note.topicId).map((t) => t.name).join(' / ')
  const lines = [`[${idx}] 《${note.title}》　路径：${path || '未归类'}`]
  if (note.tags?.length) lines.push(`标签：${note.tags.join('、')}`)
  let sec = ''
  for (const b of note.blocks || []) {
    if (b.type === 'heading') {
      sec = b.text || ''
      continue
    }
    const t = blockText(b).trim()
    if (!t) continue
    const at = sec ? `${b.type} · ${sec}` : b.type
    lines.push(`- (${at}) ${t}`)
  }
  return lines.join('\n')
}

const byUpdated = (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()

// 命中的笔记 + 分数，给 UI 里「翻了哪几篇」用
export function searchLibrary(question, { limit = MAX_NOTES } = {}) {
  const phrase = String(question || '').trim().toLowerCase()
  const toks = tokenize(question)
  const ranked = state.notes
    .map((note) => ({ note, score: scoreNote(note, toks, phrase) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) return []
  // 只沾到「怎么」这种常见二字词也算命中，会把无关笔记全捞进来；
  // 用相对最高分的下限掐掉这种噪音
  const cut = Math.max(3, ranked[0].score * 0.1)
  return ranked.filter((x) => x.score >= cut).slice(0, limit)
}

// 组资料：优先命中，一篇都没命中就退回最近改的几篇，避免模型完全瞎猜
export function buildContext(question, { budget = BUDGET } = {}) {
  const notes = state.notes.filter((n) => (n.blocks || []).length)
  if (!notes.length) return { empty: true, text: '', used: [] }

  let picked = searchLibrary(question)
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
  const notes = state.notes.length
  const blocks = state.notes.reduce(
    (s, n) => s + (n.blocks || []).filter((b) => b.type !== 'heading').length,
    0,
  )
  return { notes, blocks }
}
