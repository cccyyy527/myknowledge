// 云端布局：kb.json 存目录（域 + 分类），notes/<noteId>.json 一篇一个文件。
// 好处：改一篇只写那一个文件，git 里一篇一个 diff；换分类不用搬家（路径里没有域），
// 多端改不同笔记也不会撞在同一个文件上。
// 老布局是 notes/<domainId>.json（一个域一个文件），读的时候还认，推的时候顺手迁走。

export const SCHEMA = 3

// FNV-1a：只用来判断「这个文件有没有变」，不需要密码学强度
export function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// 只在本地有意义的字段：updatedAt 每次保存都变、version 已经不用了。
// 推到云端一律去掉，否则每次同步 git 里都多一行时间戳。
const PUSH_DROP = ['updatedAt', 'version']
const forPush = (n) => {
  const out = { ...n }
  for (const k of PUSH_DROP) delete out[k]
  return out
}

// 标签在编辑态可能是「刚加的空格子」，文件里不该有这种东西
const tidyNote = (n) =>
  forPush({
    ...n,
    tags: (n.tags || []).map((t) => String(t || '').trim()).filter(Boolean),
  })

// ---- 目录（kb.json） ----
export const indexBody = (i) => ({ schema: SCHEMA, domains: i.domains || [], topics: i.topics || [] })
export const indexKey = (i) => hashStr(JSON.stringify([SCHEMA, i.domains || [], i.topics || []]))

// ---- 单篇笔记文件 ----
export const noteBody = (n) => ({ schema: SCHEMA, note: tidyNote(n) })
// 指纹只看真内容，不看 updatedAt：否则每次保存都会推一遍，云端堆满只有一行的 commit
// 直接拿文件正文算，省得再取一遍原对象
export const noteBodyKey = (body) => hashStr(JSON.stringify([SCHEMA, body?.note ?? null]))
export const noteKey = (n) => noteBodyKey(noteBody(n))

export const dirOf = (p) => {
  const s = String(p || '')
  const i = s.lastIndexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}
export const baseNameOf = (p) => String(p || '').split('/').pop() || 'kb.json'

export const notesDirOf = (cfg) => {
  const d = dirOf(cfg.path)
  return d ? `${d}/notes` : 'notes'
}
// 路径里只有笔记 id：换分类/换域不用动文件位置
export const noteFileOf = (noteId) => `${noteId}.json`
export const notePathOf = (cfg, noteId) => `${notesDirOf(cfg)}/${noteFileOf(noteId)}`

// 文件名是不是新布局的单篇笔记（老布局的域文件叫 d4.json 这类）
const NOTE_FILE_RE = /^n-[a-z0-9]+\.json$/i
export const isNoteFile = (name) => NOTE_FILE_RE.test(String(name || ''))
export const noteIdOfFile = (name) => (isNoteFile(name) ? String(name).slice(0, -5) : '')
// 老布局的域文件：json 但不是单篇笔记
export const isDomainFile = (name) => /\.json$/i.test(String(name || '')) && !isNoteFile(name)

// 老笔记可能只有 topicId，没有 domainId
export function domainOfNote(note, topics) {
  if (note.domainId) return note.domainId
  const t = (topics || []).find((x) => x.id === note.topicId)
  return t ? t.domainId : ''
}

// 整份快照 → { index, files: { [noteId]: 文件正文 } }
export function splitNotes(snap) {
  const index = {
    schema: SCHEMA,
    domains: snap.domains || [],
    topics: snap.topics || [],
  }
  const files = {}
  for (const n of snap.notes || []) {
    if (!n || !n.id) continue
    files[n.id] = noteBody(n)
  }
  return { index, files }
}

// 一篇一个文件 → 快照。顺序按「域顺序 → 分类 → 建的时间」排，
// 这样多端拉下来的顺序是确定的，不会因为拉的先后不同而抖动
export function joinNotes(index, noteList, updatedAt) {
  const order = new Map()
  ;(index.domains || []).forEach((d, i) => order.set(d.id, i))
  const rank = (n) => {
    const d = domainOfNote(n, index.topics || [])
    return order.has(d) ? order.get(d) : 999
  }
  const notes = [...noteList].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(a.topicId || '').localeCompare(String(b.topicId || '')) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.id).localeCompare(String(b.id)),
  )
  return {
    domains: index.domains || [],
    topics: index.topics || [],
    notes,
    updatedAt: updatedAt || 0,
  }
}

// 老布局：notes/<domainId>.json 里带 notes 数组
export function notesFromDomainFile(data) {
  if (!data || !Array.isArray(data.notes)) return []
  return data.notes.map((n) => ({ ...n, domainId: n.domainId || data.domainId || '' }))
}

// 更老：kb.json 里直接带 notes 数组
export const isLegacy = (data) => Array.isArray(data?.notes)
