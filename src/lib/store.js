import { reactive, watch } from 'vue'
import { DOMAINS, TOPICS, DEMO_NOTE } from './seed.js'

// 原型阶段：全部数据放 localStorage，刷新不丢；清浏览器数据会丢
const KEY = 'myknowledge.v3'
// 最后修改时间单独存：放进 state 会让 deep watch 自触发成死循环
const TS_KEY = 'myknowledge.updatedAt'

const initial = () => ({
  domains: DOMAINS,
  topics: TOPICS,
  notes: [JSON.parse(JSON.stringify(DEMO_NOTE))],
})

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const data = JSON.parse(raw)
      if (data?.notes && data?.topics) return data
    }
  } catch (e) {
    console.warn('本地数据读取失败，改用初始骨架', e)
  }
  return initial()
}

export const state = reactive(load())

let updatedAt = Number(localStorage.getItem(TS_KEY)) || 0
export const lastUpdated = () => updatedAt

// 深拷贝快照：上传远端 / 导出 JSON 都走这里
export const snapshot = () => ({
  domains: JSON.parse(JSON.stringify(state.domains)),
  topics: JSON.parse(JSON.stringify(state.topics)),
  notes: JSON.parse(JSON.stringify(state.notes)),
  updatedAt,
})

watch(
  state,
  () => {
    updatedAt = Date.now()
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot()))
      localStorage.setItem(TS_KEY, String(updatedAt))
    } catch (e) {
      console.warn('本地数据写入失败', e)
    }
  },
  { deep: true },
)

// 用远端数据整体替换本地（拉取后调用）
export function applyRemote(data) {
  state.domains = data.domains || []
  state.topics = data.topics || []
  state.notes = data.notes || []
  updatedAt = data.updatedAt || Date.now()
  localStorage.setItem(TS_KEY, String(updatedAt))
}

export const topicById = (id) => state.topics.find((t) => t.id === id)
export const domainById = (id) => state.domains.find((d) => d.id === id)
export const noteById = (id) => state.notes.find((n) => n.id === id)

// 一级分类（挂在域下面，parentId === ''）
export const topicsOf = (domainId) =>
  state.topics.filter((t) => t.domainId === domainId && !t.parentId)

export const childrenOf = (topicId) => state.topics.filter((t) => t.parentId === topicId)
export const isLeaf = (topicId) => childrenOf(topicId).length === 0

// 从根到自己的祖先链
export function topicPath(topicId) {
  const out = []
  let cur = topicById(topicId)
  while (cur) {
    out.unshift(cur)
    cur = cur.parentId ? topicById(cur.parentId) : null
  }
  return out
}

// 自己 + 全部后代
export function subtreeIds(topicId) {
  const out = [topicId]
  for (const c of childrenOf(topicId)) out.push(...subtreeIds(c.id))
  return out
}

// 扁平化成带缩进层级的可见列表，用于侧边栏渲染；isOpen 传 true 表示全展开
export function flattenTopics(domainId, isOpen) {
  const opened = (id) => (typeof isOpen === 'boolean' ? isOpen : !!isOpen[id])
  const out = []
  const walk = (list, depth) => {
    for (const t of list) {
      const kids = childrenOf(t.id)
      out.push({ topic: t, depth, hasKids: kids.length > 0, open: opened(t.id) })
      if (kids.length && opened(t.id)) walk(kids, depth + 1)
    }
  }
  walk(topicsOf(domainId), 0)
  return out
}

export const notesOfTopic = (topicId) =>
  state.notes.filter((n) => n.topicId === topicId).sort(byPinnedThenUpdated)

// 含下级的笔记，用于「分组」页汇总
export function notesOfSubtree(topicId) {
  const ids = new Set(subtreeIds(topicId))
  return state.notes.filter((n) => ids.has(n.topicId)).sort(byPinnedThenUpdated)
}

export const notesOfDomain = (domainId) =>
  state.notes.filter((n) => n.domainId === domainId).sort(byPinnedThenUpdated)

function byPinnedThenUpdated(a, b) {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

const countType = (note, type) => note.blocks.filter((b) => b.type === type).length

export function noteBadges(note) {
  const b = note.blocks
  return {
    formulas: b.filter((x) => x.type === 'formula').length,
    qa: b.filter((x) => x.type === 'qa').length,
    pitfalls: b.filter((x) => x.type === 'pitfall').length,
    todos: b.filter((x) => x.type === 'todo').length,
  }
}

export function noteSummary(note) {
  const p = note.blocks.find((b) => b.type === 'paragraph' && b.text?.trim())
  if (!p) return '（还没有内容）'
  return p.text.length > 70 ? p.text.slice(0, 70) + '…' : p.text
}

export function domainStats(domainId) {
  const all = state.topics.filter((t) => t.domainId === domainId)
  const leaves = all.filter((t) => isLeaf(t.id))
  const notes = notesOfDomain(domainId)
  return {
    topics: all.length,
    leaves: leaves.length,
    covered: leaves.filter((t) => notesOfTopic(t.id).length > 0).length,
    notes: notes.length,
    todos: notes.reduce((s, n) => s + countType(n, 'todo'), 0),
  }
}

export function topicStats(topicId) {
  const own = notesOfTopic(topicId)
  const all = notesOfSubtree(topicId)
  return {
    notes: own.length,
    all: all.length,
    kids: childrenOf(topicId).length,
    todos: all.reduce((s, n) => s + countType(n, 'todo'), 0),
  }
}

/* ---------------- 目录编辑 ---------------- */

const uid = (p) => p + Math.random().toString(36).slice(2, 8)

export function createDomain(name = '新域') {
  const d = { id: uid('d-'), slug: '', name }
  state.domains.push(d)
  return d
}

export function createTopic(domainId, parentId = '', name = '新分类') {
  const t = { id: uid('t-'), domainId, parentId, slug: '', name }
  state.topics.push(t)
  return t
}

export function renameDomain(id, name) {
  const d = domainById(id)
  if (d && name.trim()) d.name = name.trim()
}

export function renameTopic(id, name) {
  const t = topicById(id)
  if (t && name.trim()) t.name = name.trim()
}

export function moveTopic(id, delta) {
  const t = topicById(id)
  if (!t) return
  const siblings = state.topics.filter((x) => x.domainId === t.domainId && x.parentId === t.parentId)
  const i = siblings.indexOf(t)
  const j = i + delta
  if (j < 0 || j >= siblings.length) return
  // 在全局数组里交换，保持同级相对顺序
  const a = state.topics.indexOf(siblings[i])
  const b = state.topics.indexOf(siblings[j])
  ;[state.topics[a], state.topics[b]] = [state.topics[b], state.topics[a]]
}

// 该域下的「未归类」兜底分类，删分类时笔记落这里
function inboxOf(domainId) {
  let t = state.topics.find((x) => x.domainId === domainId && x.slug === 'inbox')
  if (!t) {
    t = { id: uid('t-'), domainId, parentId: '', slug: 'inbox', name: '未归类' }
    state.topics.unshift(t)
  }
  return t
}

// 删分类：笔记上移到父级；一级分类的笔记落到「未归类」。返回被移动的笔记数
export function removeTopic(topicId) {
  const t = topicById(topicId)
  if (!t) return 0
  const fallback = t.parentId ? topicById(t.parentId) : inboxOf(t.domainId)
  const ids = new Set(subtreeIds(topicId))
  let moved = 0
  for (const n of state.notes) {
    if (ids.has(n.topicId)) {
      n.topicId = fallback.id
      moved++
    }
  }
  state.topics = state.topics.filter((x) => !ids.has(x.id))
  return moved
}

export function removeDomain(domainId) {
  if (notesOfDomain(domainId).length) return false
  const ids = new Set(state.topics.filter((t) => t.domainId === domainId).map((t) => t.id))
  state.topics = state.topics.filter((t) => !ids.has(t.id))
  state.domains = state.domains.filter((d) => d.id !== domainId)
  return true
}

export function createNote(topicId) {
  const topic = topicById(topicId)
  const now = new Date().toISOString()
  const note = {
    id: 'n-' + Math.random().toString(36).slice(2, 10),
    domainId: topic.domainId,
    topicId: topic.id,
    title: '未命名笔记',
    pinned: false,
    tags: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    blocks: templateBlocks(),
  }
  state.notes.push(note)
  return note
}

function templateBlocks() {
  let i = 0
  const id = () => `b-${Date.now()}-${++i}`
  return [
    { id: id(), type: 'heading', level: 2, text: '核心结论' },
    { id: id(), type: 'paragraph', text: '' },
    { id: id(), type: 'heading', level: 2, text: '推导 / 细节' },
    { id: id(), type: 'paragraph', text: '' },
    { id: id(), type: 'heading', level: 2, text: '高频问法' },
    { id: id(), type: 'qa', question: '', answer: '' },
    { id: id(), type: 'heading', level: 2, text: '我踩过的坑' },
    { id: id(), type: 'pitfall', text: '', cause: '', avoid: '' },
  ]
}

export const newBlockId = () => 'b-' + Math.random().toString(36).slice(2, 10)

export function touchNote(note) {
  note.updatedAt = new Date().toISOString()
  note.version = (note.version || 1) + 1
}

export function removeNote(id) {
  const i = state.notes.findIndex((n) => n.id === id)
  if (i >= 0) state.notes.splice(i, 1)
}

export function searchNotes(q) {
  const kw = q.trim().toLowerCase()
  if (!kw) return []
  const hits = []
  for (const n of state.notes) {
    const titleHit = n.title.toLowerCase().includes(kw)
    const blockHit = n.blocks.find((b) => blockText(b).toLowerCase().includes(kw))
    if (titleHit || blockHit) {
      const ctx = blockHit ? snippet(blockText(blockHit), kw) : noteSummary(n)
      hits.push({ note: n, ctx })
    }
  }
  return hits
}

function blockText(b) {
  return [b.text, b.term, b.detail, b.question, b.answer, b.cause, b.avoid, b.latex]
    .filter(Boolean)
    .join(' ')
}

function snippet(text, kw) {
  const i = text.toLowerCase().indexOf(kw)
  const start = Math.max(0, i - 24)
  return (start > 0 ? '…' : '') + text.slice(start, start + 70) + '…'
}

// 全局聚合：术语 / 公式 / 问答 / 坑
export function aggregate(type) {
  const out = []
  for (const note of state.notes) {
    for (const b of note.blocks) {
      if (b.type === type && (b.term || b.latex || b.question || b.text)) out.push({ block: b, note })
    }
  }
  return out
}
