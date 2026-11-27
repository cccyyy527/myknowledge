/* ---------- 笔记互引 ----------
   正文里写 [[目标]] 或 [[目标|显示文字]]，阅读态渲染成可点的 chip；
   那个段落里只有一个 [[ ]] 时，渲染成整块卡片。
   引用关系不写进存储，每次加载现算，所以云端 JSON 结构不变。

   目标是 n-xxx 形式的笔记 id → 按 id 认，改名 / 换分类都不断链。
   目标不是 id → 按标题认，兼容手写的 [[标题]] 和「还没创建」的占位链接。 */

const SRC = '\\[\\[([^\\[\\]\\n|]{1,80})(?:\\|([^\\[\\]\\n]{1,80}))?\\]\\]'
const CARD_RE = /^\s*\[\[[^\[\]\n]{1,90}\]\]\s*$/

export const isWholeCard = (text) => CARD_RE.test(String(text || ''))

// 全角空格、连续空白、大小写都不该影响「是不是同一篇」
export const normTitle = (t) =>
  String(t || '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .toLowerCase()

export const isNoteId = (t) => /^n-[a-z0-9]+$/i.test(String(t || '').trim())

// 会被渲染成 chip 的字段。改写链接（迁移 / 改名）和算反链都按这张表走，
// 保证「动过的字」和「看得见的链接」永远是同一批
export const LINK_FIELDS = {
  paragraph: ['text'],
  qa: ['answer'],
  callout: ['text'],
  todo: ['text'],
  definition: ['text', 'detail'],
}

const fieldsOf = (b) => (b && LINK_FIELDS[b.type]) || []

export const blockLinkText = (b) =>
  fieldsOf(b)
    .map((f) => b[f] || '')
    .join('\n')

// [{ target, display }]：target 可能是 id 也可能是标题，display 没写就是空串
export function linksIn(text) {
  const out = []
  const re = new RegExp(SRC, 'g')
  let m
  while ((m = re.exec(String(text || '')))) {
    out.push({ target: m[1].trim(), display: (m[2] || '').trim() })
  }
  return out
}

export const titlesIn = (text) => linksIn(text).map((l) => l.target)

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

export function idIndex(notes) {
  const map = new Map()
  for (const n of notes || []) map.set(n.id, n)
  return map
}

// 一个链接指向哪篇笔记：id 优先，认不出再当标题找
export function resolveLink(link, notes) {
  const target = String(link?.target || '').trim()
  if (!target) return null
  if (isNoteId(target)) return (notes || []).find((n) => n.id === target) || null
  return resolveTitle(target, notes)
}

// chip 上显示什么：写了显示文字就用它，否则用目标笔记现在的标题
export const linkLabel = (link, hit) =>
  String(link?.display || '').trim() || (hit ? hit.title : String(link?.target || ''))

// 只有「目标不是 id」的链接才谈得上「未创建」——id 找不到就是真的没了
export const canCreate = (link) => !isNoteId(link?.target)

/* ---------- 迁移：[[标题]] → [[id]] ---------- */

// 把一段文字里的标题链接换成 id 链接；标题对不上任何一篇的原样留着
export function idifyText(text, byTitle) {
  return String(text || '').replace(new RegExp(SRC, 'g'), (m, target, display) => {
    const t = String(target).trim()
    if (isNoteId(t)) return m
    const hit = byTitle.get(normTitle(t))
    if (!hit) return m
    return display ? `[[${hit.id}|${display.trim()}]]` : `[[${hit.id}]]`
  })
}

// 全库扫一遍，返回动过的块（调用方负责 touchNote）
export function idifyAll(notes) {
  const byTitle = titleIndex(notes)
  const touched = []
  for (const n of notes || []) {
    for (const b of n.blocks || []) {
      let dirty = false
      for (const f of fieldsOf(b)) {
        const before = b[f] || ''
        const after = idifyText(before, byTitle)
        if (after !== before) {
          b[f] = after
          dirty = true
        }
      }
      if (dirty) touched.push({ note: n, block: b })
    }
  }
  return touched
}

/* ---------- 改名：把还按标题认的引用跟过去 ---------- */

// 旧标题的链接 → [[id]]；[[id|旧标题]] 这种「显示文字正好是旧标题」的也收回成 [[id]]，
// 显示名就能自动跟着新标题走。用户自己起的别名（不等于旧标题）不动
export function relinkText(text, noteId, oldTitle) {
  const key = normTitle(oldTitle)
  if (!key) return String(text || '')
  return String(text || '').replace(new RegExp(SRC, 'g'), (m, target, display) => {
    const t = String(target).trim()
    const d = String(display || '').trim()
    const byTitle = !isNoteId(t) && normTitle(t) === key
    const byAlias = t === noteId && normTitle(d) === key
    if (!byTitle && !byAlias) return m
    return `[[${noteId}]]`
  })
}

// 引用了这篇笔记（按 id 或按旧标题都算）的字段
export function refsToNote(notes, noteId, oldTitle) {
  const key = normTitle(oldTitle)
  const out = []
  for (const n of notes || []) {
    if (n.id === noteId) continue
    for (const b of n.blocks || []) {
      const hit = fieldsOf(b).some((f) =>
        linksIn(b[f]).some(
          (l) => l.target === noteId || (key && !isNoteId(l.target) && normTitle(l.target) === key),
        ),
      )
      if (hit) out.push({ note: n, block: b })
    }
  }
  return out
}

/* ---------- 反链 ---------- */

// 那一句上下文，反链里给人看的。[[ ]] 换成「这篇笔记叫什么」而不是裸 id
function around(text, needle, notes) {
  const flat = String(text || '').replace(/\s+/g, ' ')
  const re = new RegExp(SRC, 'g')
  let m
  while ((m = re.exec(flat))) {
    const t = m[1].trim()
    const ok = needle.id ? t === needle.id : !isNoteId(t) && normTitle(t) === needle.key
    if (!ok) continue
    const a = Math.max(0, m.index - 40)
    const b = Math.min(flat.length, m.index + m[0].length + 40)
    const win = flat.slice(a, b).replace(new RegExp(SRC, 'g'), (_x, body) => {
      const cut = String(body).indexOf('|')
      const link =
        cut < 0
          ? { target: String(body).trim(), display: '' }
          : { target: String(body).slice(0, cut).trim(), display: String(body).slice(cut + 1).trim() }
      return linkLabel(link, resolveLink(link, notes))
    })
    return (a > 0 ? '…' : '') + win + (b < flat.length ? '…' : '')
  }
  return ''
}

// 谁引用了我：同一篇只列一次，带上下文片段
export function backlinksTo(noteId, notes) {
  const me = (notes || []).find((n) => n.id === noteId)
  if (!me) return []
  const needle = { id: me.id, key: normTitle(me.title) }
  const out = []
  for (const n of notes || []) {
    if (n.id === noteId) continue
    for (const b of n.blocks || []) {
      const text = blockLinkText(b)
      if (!text) continue
      const hit = linksIn(text).some(
        (l) => l.target === needle.id || (needle.key && !isNoteId(l.target) && normTitle(l.target) === needle.key),
      )
      if (!hit) continue
      out.push({ from: n.id, title: n.title, snippet: around(text, needle, notes) })
      break
    }
  }
  return out
}

// 断链清单：指向不存在目标的 [[ ]] 都在哪
export function brokenLinks(notes) {
  const byId = idIndex(notes)
  const byTitle = titleIndex(notes)
  const out = []
  for (const n of notes || []) {
    for (const b of n.blocks || []) {
      for (const f of fieldsOf(b)) {
        for (const l of linksIn(b[f])) {
          const ok = isNoteId(l.target) ? byId.has(l.target) : byTitle.has(normTitle(l.target))
          if (!ok) out.push({ note: n, block: b, field: f, link: l })
        }
      }
    }
  }
  return out
}

// 这个标题还被多少篇按标题引用着（改名前给个提示）。只数按标题认的那些
export function inboundCount(title, notes) {
  const key = normTitle(title)
  if (!key) return 0
  let n = 0
  for (const note of notes || []) {
    for (const b of note.blocks || []) {
      const text = blockLinkText(b)
      if (text && linksIn(text).some((l) => !isNoteId(l.target) && normTitle(l.target) === key)) {
        n++
        break
      }
    }
  }
  return n
}
