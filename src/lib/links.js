/* ---------- 笔记互引 ----------
   正文里写 [[另一篇的标题]]，阅读态渲染成可点的 chip；
   那个段落里只有一个 [[ ]] 时，渲染成整块卡片。
   引用关系不写进存储，每次加载现算，所以云端 JSON 结构不变。 */

const SRC = '\\[\\[([^\\[\\]\\n]{1,80})\\]\\]'
const CARD_RE = /^\s*\[\[[^\[\]\n]{1,80}\]\]\s*$/

export const isWholeCard = (text) => CARD_RE.test(String(text || ''))

// 全角空格、连续空白、大小写都不该影响「是不是同一篇」
export const normTitle = (t) =>
  String(t || '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .toLowerCase()

// 只有会被渲染成 chip 的字段才算引用，保证「看得见的链接」和反链一一对应
export const blockLinkText = (b) => {
  if (!b) return ''
  if (b.type === 'paragraph') return b.text || ''
  if (b.type === 'qa') return b.answer || ''
  if (b.type === 'callout') return b.text || ''
  if (b.type === 'todo') return b.text || ''
  if (b.type === 'definition') return [b.text, b.detail].filter(Boolean).join('\n')
  return ''
}

export function titlesIn(text) {
  const out = []
  const re = new RegExp(SRC, 'g')
  let m
  while ((m = re.exec(String(text || '')))) out.push(m[1].trim())
  return out
}

export function titleIndex(notes) {
  const map = new Map()
  for (const n of notes || []) {
    const k = normTitle(n.title)
    if (k && !map.has(k)) map.set(k, n)
  }
  return map
}

export const resolveTitle = (title, notes) => {
  const k = normTitle(title)
  if (!k) return null
  for (const n of notes || []) if (normTitle(n.title) === k) return n
  return null
}

// 那一句上下文，反链里给人看的
function around(text, title) {
  const key = normTitle(title)
  const flat = String(text || '').replace(/\s+/g, ' ')
  const re = new RegExp(SRC, 'g')
  let m
  while ((m = re.exec(flat))) {
    if (normTitle(m[1]) !== key) continue
    const a = Math.max(0, m.index - 40)
    const b = Math.min(flat.length, m.index + m[0].length + 40)
    return (
      (a > 0 ? '…' : '') +
      flat.slice(a, b).replace(/\[\[|\]\]/g, '') +
      (b < flat.length ? '…' : '')
    )
  }
  return ''
}

// 谁引用了我：同一篇只列一次，带上下文片段
export function backlinksTo(noteId, notes) {
  const me = (notes || []).find((n) => n.id === noteId)
  if (!me) return []
  const key = normTitle(me.title)
  if (!key) return []
  const out = []
  for (const n of notes || []) {
    if (n.id === noteId) continue
    for (const b of n.blocks || []) {
      const text = blockLinkText(b)
      if (!text) continue
      if (!titlesIn(text).some((t) => normTitle(t) === key)) continue
      out.push({ from: n.id, title: n.title, snippet: around(text, me.title) })
      break
    }
  }
  return out
}

// 这个标题被引用了多少次（列表里给个提示）
export function inboundCount(title, notes) {
  const key = normTitle(title)
  if (!key) return 0
  let n = 0
  for (const note of notes || []) {
    for (const b of note.blocks || []) {
      const text = blockLinkText(b)
      if (text && titlesIn(text).some((t) => normTitle(t) === key)) {
        n++
        break
      }
    }
  }
  return n
}
