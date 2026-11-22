import { reactive, watch } from 'vue'
import { DOMAINS, TOPICS, DEMO_NOTE } from './seed.js'

// 原型阶段：全部数据放 localStorage，刷新不丢；清浏览器数据会丢
const KEY = 'myknowledge.v1'

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

watch(
  state,
  () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ domains: state.domains, topics: state.topics, notes: state.notes }),
      )
    } catch (e) {
      console.warn('本地数据写入失败', e)
    }
  },
  { deep: true },
)

export const topicById = (id) => state.topics.find((t) => t.id === id)
export const domainById = (id) => state.domains.find((d) => d.id === id)
export const noteById = (id) => state.notes.find((n) => n.id === id)
export const topicsOf = (domainId) => state.topics.filter((t) => t.domainId === domainId)
export const notesOfTopic = (topicId) =>
  state.notes.filter((n) => n.topicId === topicId).sort(byPinnedThenUpdated)
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
  const topics = topicsOf(domainId)
  const notes = notesOfDomain(domainId)
  return {
    topics: topics.length,
    covered: topics.filter((t) => notesOfTopic(t.id).length > 0).length,
    notes: notes.length,
    todos: notes.reduce((s, n) => s + countType(n, 'todo'), 0),
  }
}

export function topicStats(topicId) {
  const notes = notesOfTopic(topicId)
  return {
    notes: notes.length,
    todos: notes.reduce((s, n) => s + countType(n, 'todo'), 0),
  }
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
