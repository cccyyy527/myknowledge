import { reactive, watch } from 'vue'
import { DOMAINS, TOPICS, DEMO_NOTE } from './seed.js'
import { idifyAll, idifyText, inboundCount, LINK_FIELDS, refsToNote, relinkText, titleIndex } from './links.js'

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
// 标签在编辑态可能是「刚加的空格子」，出库前清掉，别把空串写进云端
export const snapshot = () => ({
  domains: JSON.parse(JSON.stringify(state.domains)),
  topics: JSON.parse(JSON.stringify(state.topics)),
  notes: JSON.parse(JSON.stringify(state.notes)).map((n) => ({
    ...n,
    tags: (n.tags || []).map((t) => String(t).trim()).filter(Boolean),
  })),
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

/* ---------------- 软删除：笔记上挂 deletedAt ----------------
   不真的从数组里去掉：回收站要能捞回来，云端文件结构也不用动 —— 
   deletedAt 跟着笔记一起进它所在域的那个 json，多出来的字段老代码不认也无所谓。 */

export const liveNotes = () => state.notes.filter((n) => !n.deletedAt)

export const trashedNotes = () =>
  state.notes
    .filter((n) => n.deletedAt)
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))

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
  state.notes.filter((n) => n.topicId === topicId && !n.deletedAt).sort(byPinnedThenUpdated)

// 含下级的笔记，用于「分组」页汇总
export function notesOfSubtree(topicId) {
  const ids = new Set(subtreeIds(topicId))
  return state.notes.filter((n) => ids.has(n.topicId) && !n.deletedAt).sort(byPinnedThenUpdated)
}

export const notesOfDomain = (domainId) =>
  state.notes.filter((n) => n.domainId === domainId && !n.deletedAt).sort(byPinnedThenUpdated)

// 域没了（别的设备删掉后合并回来、或老数据里 domainId 指向不存在的域），
// 笔记会落到 notes/_orphan.json。文件有兜底，界面也得看得见，否则就是黑洞。
export function orphanNotes() {
  const ids = new Set(state.domains.map((d) => d.id))
  return state.notes
    .filter((n) => {
      if (n.deletedAt) return false
      const domainId = n.domainId || topicById(n.topicId)?.domainId || ''
      return !ids.has(domainId)
    })
    .sort(byPinnedThenUpdated)
}

// 把失去归属的笔记重新挂到某个分类下
export function adoptNote(noteId, topicId) {
  const n = noteById(noteId)
  const t = topicById(topicId)
  if (!n || !t) return false
  n.domainId = t.domainId
  n.topicId = t.id
  touchNote(n)
  return true
}

// 在分类之间挪一篇正常笔记（orphan 用 adoptNote，两者等价，这里语义更直白）
export const moveNote = (noteId, topicId) => adoptNote(noteId, topicId)

// 云端不存 updatedAt，拉回本机时才会补上；万一还是缺，就退回 createdAt
const stampOf = (n) => new Date(n.updatedAt || n.createdAt || 0).getTime() || 0

function byPinnedThenUpdated(a, b) {
  return Number(b.pinned) - Number(a.pinned) || stampOf(b) - stampOf(a)
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

export function removeDomain(domainId, force = false) {
  if (!force && notesOfDomain(domainId).length) return false
  const ids = new Set(state.topics.filter((t) => t.domainId === domainId).map((t) => t.id))
  if (force) {
    // 域连同笔记一起删：笔记不能凭空消失，脱掉归属落进 notes/_orphan.json，
    // 用户可以在「失去归属的笔记」里重新指一个分类，或者直接删掉
    for (const n of state.notes) {
      if (n.domainId === domainId || ids.has(n.topicId)) {
        n.domainId = ''
        n.topicId = ''
      }
    }
  }
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

// 把若干块塞到某个段落末尾；没有这一段就在文末新起一段
// AI / 模板写进来的块里带的还是 [[标题]]，落库前先换成 [[id]]，省得以后改名断链
export function insertBlocks(note, sectionTitle, blocks) {
  if (!note || !blocks || !blocks.length) return
  const byTitle = titleIndex(liveNotes())
  for (const b of blocks) {
    for (const f of LINK_FIELDS[b.type] || []) {
      if (b[f]) b[f] = idifyText(b[f], byTitle)
    }
  }
  const arr = note.blocks
  const hit = arr.findIndex(
    (b) => b.type === 'heading' && b.level === 2 && b.text === sectionTitle,
  )
  if (hit < 0) {
    arr.push(
      { id: newBlockId(), type: 'heading', level: 2, text: sectionTitle },
      ...blocks,
    )
    return
  }
  let end = hit + 1
  for (let j = hit + 1; j < arr.length; j++) {
    if (arr[j].type === 'heading' && arr[j].level === 2) break
    end = j + 1
  }
  arr.splice(end, 0, ...blocks)
}

export function touchNote(note) {
  // 只动 updatedAt：version 既不展示也不参与云端指纹，不再自增
  note.updatedAt = new Date().toISOString()
}

/* ---------- 改名 ---------- 
   正文里的链接默认写 [[id]]，改名本来就不影响；
   这里额外处理「还按标题引用的老链接」，让它们一起跟过来，别静默断掉。 */

// 这次改名会牵动多少篇（只数还按标题引用旧标题的）
export const renameImpact = (id, nextTitle) => {
  const n = noteById(id)
  if (!n || !String(nextTitle || '').trim()) return 0
  return inboundCount(n.title, liveNotes())
}

// 改标题：顺手把指向旧标题的 [[ ]] 换成 [[id]]。返回被牵连的笔记数
export function renameNote(id, nextTitle) {
  const n = noteById(id)
  if (!n) return { ok: false, refs: 0 }
  const next = String(nextTitle || '').trim()
  if (!next || next === n.title) return { ok: false, refs: 0 }
  const old = n.title
  const hits = refsToNote(liveNotes(), id, old)
  for (const { note, block } of hits) {
    for (const f of Object.keys(block)) {
      if (typeof block[f] !== 'string' || !block[f].includes('[[')) continue
      block[f] = relinkText(block[f], id, old)
    }
    touchNote(note)
  }
  n.title = next
  touchNote(n)
  return { ok: true, refs: hits.length }
}

/* ---------- 一次性迁移：[[标题]] → [[id]] ---------- 
   老内容里的链接是标题字面量。趁现在目标唯一，全部换成 id，
   以后改名 / 换分类就不会断。对不上任何一篇的（占位链接）原样保留。 */
const LINK_MIG_KEY = 'myknowledge.links.idified'

export function idifyLinks(force = false) {
  if (!force && localStorage.getItem(LINK_MIG_KEY) === '1') return 0
  const touched = idifyAll(liveNotes())
  for (const { note } of touched) touchNote(note)
  localStorage.setItem(LINK_MIG_KEY, '1')
  return touched.length
}

// 软删除：进回收站，能捞回来；要真删得走 purgeNote
export function removeNote(id) {
  const n = noteById(id)
  if (!n) return false
  n.deletedAt = new Date().toISOString()
  touchNote(n)
  return true
}

export function restoreNote(id) {
  const n = noteById(id)
  if (!n || !n.deletedAt) return false
  delete n.deletedAt
  touchNote(n)
  return true
}

// 彻底删除（不可恢复）
export function purgeNote(id) {
  const i = state.notes.findIndex((n) => n.id === id && n.deletedAt)
  if (i >= 0) state.notes.splice(i, 1)
}

export function emptyTrash() {
  state.notes = state.notes.filter((n) => !n.deletedAt)
}

// 回收站里的一篇要重新挂回分类：原来的分类可能已经没了
export const trashTopicOf = (note) => topicById(note.topicId) || null

export function searchNotes(q) {
  const kw = q.trim().toLowerCase()
  if (!kw) return []
  const hits = []
  for (const n of state.notes) {
    if (n.deletedAt) continue
    const titleHit = n.title.toLowerCase().includes(kw)
    const tagHit = (n.tags || []).find((t) => String(t).toLowerCase().includes(kw))
    const blockHit = n.blocks.find((b) => blockText(b).toLowerCase().includes(kw))
    if (titleHit || tagHit || blockHit) {
      const ctx = blockHit
        ? snippet(blockText(blockHit), kw)
        : tagHit
          ? `标签 #${tagHit}`
          : noteSummary(n)
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

// 全局聚合：术语 / 公式 / 问答 / 坑 / 待补
export function aggregate(type) {
  const out = []
  for (const note of state.notes) {
    if (note.deletedAt) continue
    for (const b of note.blocks) {
      if (b.type === type && (b.term || b.latex || b.question || b.text)) out.push({ block: b, note })
    }
  }
  return out
}

// 待补清单上「做完了」= 把那块删掉；块级删除不进回收站，所以这里顺带给一句确认
export function dropBlock(noteId, blockId) {
  const n = noteById(noteId)
  if (!n) return false
  const i = (n.blocks || []).findIndex((b) => b.id === blockId)
  if (i < 0) return false
  n.blocks.splice(i, 1)
  touchNote(n)
  return true
}
