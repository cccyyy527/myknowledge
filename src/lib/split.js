// 把整份快照拆成「分类索引 + 每个域一个笔记文件」
// 好处：改一篇笔记只写它所在域的那个文件，commit 小、diff 能看、多端改不同域能合并

export const SCHEMA = 2

// FNV-1a：只用来判断「这个文件有没有变」，不需要密码学强度
export function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// 推到云端的文件里不带 updatedAt：它每次保存都变，带上就等于每次都产生 diff
export const fileBody = (f) => ({ schema: f.schema, domainId: f.domainId, notes: f.notes })
export const indexBody = (i) => ({ schema: i.schema, domains: i.domains || [], topics: i.topics || [] })

// 「内容指纹」：只看真内容，不看 updatedAt / version。
// 时间戳和版本号每次保存都变，算进去就等于每次都推，云端会堆满只有一行的 commit。
const noteSig = (n) => {
  const { updatedAt, version, ...rest } = n
  return rest
}
export const fileKey = (f) => hashStr(JSON.stringify([f.schema, f.domainId, (f.notes || []).map(noteSig)]))

// 老版本把 note.updatedAt 也算进指纹。留着它只为了认得出「升级前存下的指纹」，
// 免得升到新版本后第一次同步把所有域文件重推一遍。
const fileKeyLegacy = (f) => hashStr(JSON.stringify([f.schema, f.domainId, f.notes]))
export const keyMatches = (stored, f) => Boolean(stored) && (stored === fileKey(f) || stored === fileKeyLegacy(f))
export const indexKey = (i) => hashStr(JSON.stringify([i.schema, i.domains, i.topics]))

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
export const noteFileOf = (domainId) => `${domainId || '_orphan'}.json`
export const notePathOf = (cfg, domainId) => `${notesDirOf(cfg)}/${noteFileOf(domainId)}`

// 老笔记可能只有 topicId，没有 domainId
export function domainOfNote(note, topics) {
  if (note.domainId) return note.domainId
  const t = topics.find((x) => x.id === note.topicId)
  return t ? t.domainId : ''
}

// 每个域都出一个文件（空的也出），这样把某域笔记删光时远端文件会被清成 []，
// 而不是残留旧内容等着下次被拉回来
// 标签在编辑态可能是「刚加的空格子」，文件里不该有这种东西
const tidyNote = (n) => ({
  ...n,
  tags: (n.tags || []).map((t) => String(t || '').trim()).filter(Boolean),
})

export function splitSnapshot(snap) {
  const index = {
    schema: SCHEMA,
    domains: snap.domains || [],
    topics: snap.topics || [],
  }

  const buckets = new Map()
  for (const d of index.domains) buckets.set(d.id, [])
  for (const n of snap.notes || []) {
    const id = domainOfNote(n, index.topics)
    if (!buckets.has(id)) buckets.set(id, [])
    buckets.get(id).push(tidyNote(n))
  }

  const files = {}
  for (const [domainId, notes] of buckets) {
    files[noteFileOf(domainId)] = {
      schema: SCHEMA,
      domainId,
      notes,
    }
  }
  return { index, files }
}

// 合并回来；顺序按 index.topics 的域顺序，保证多次拉取结果稳定
export function joinFiles(index, fileList) {
  const byDomain = new Map()
  for (const f of fileList) {
    if (f) byDomain.set(f.domainId || '', f.notes || [])
  }
  const notes = []
  const seen = new Set()
  for (const d of index.domains || []) {
    const arr = byDomain.get(d.id)
    if (!arr) continue
    seen.add(d.id)
    notes.push(...arr)
  }
  for (const [id, arr] of byDomain) {
    if (!seen.has(id)) notes.push(...arr)
  }
  return {
    domains: index.domains || [],
    topics: index.topics || [],
    notes,
    updatedAt: index.updatedAt || 0,
  }
}

// 老版本：kb.json 里直接带 notes 数组
export const isLegacy = (data) => Array.isArray(data?.notes)
