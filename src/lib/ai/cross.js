// 跨笔记：把一组笔记揉成一篇新的（原篇一块都不动），或者只读地查它们之间的说法冲突

import {
  state,
  liveNoteById,
  createNote,
  idifyBlocks,
  touchNote,
  rewriteNote,
  restoreNoteVersion,
  restoreNote,
  removeNote,
} from '../store.js'
import { noteText, blockText } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import {
  SECTIONS,
  str,
  arr,
  normalizeBlocks,
  assembleBlocks,
  stripMark,
} from './schema.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { systemFor } from './skills/index.js'
import { reviseNote, applyOps, sectioned } from './revise.js'
import { pairScore, flatOf } from './block-edit.js'

const MAX_NOTES = 6
const BUDGET = 5000 // 每篇塞进 prompt 的字数上限，几篇加起来别把窗口撑爆

const pickNotes = (ids) =>
  arr(ids)
    .map((id) => liveNoteById(id))
    .filter(Boolean)
    .slice(0, MAX_NOTES)

const pathName = (topicId) => {
  const names = []
  let cur = state.topics.find((t) => t.id === topicId)
  let guard = 0
  while (cur && guard++ < 12) {
    names.unshift(cur.name)
    cur = cur.parentId ? state.topics.find((t) => t.id === cur.parentId) : null
  }
  return names.join(' / ')
}

// 选中的几篇摊成一段文本：编号 + 标题 + 正文章节，模型靠编号和引号引用原文
const packNotes = (notes) =>
  notes
    .map((n, i) => `[${i + 1}] ${noteText(n, { budget: BUDGET })}`)
    .join('\n\n---\n\n')

/* ---------- 整合成一篇新笔记 ---------- */

export async function mergeNotes({ ids, instruction = '', cfg } = {}) {
  const notes = pickNotes(ids)
  if (notes.length < 2) throw new Error('至少要选两篇')
  const user = `分类树：
${topicCatalog()}

要合进来的笔记（[n] 是编号）：

${packNotes(notes)}

额外要求：${instruction || '（没有，按你的判断合）'}`

  const text = await chat(
    [
      { role: 'system', content: systemFor('merge') },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.25, maxTokens: 8000 },
  )
  const data = pickJson(text)
  return {
    title: str(data.title) || '未命名笔记',
    topicId: topicExists(data.topicId) ? data.topicId : fallbackTopicId(),
    recommended: str(data.topicId),
    reason: str(data.reason),
    advice: str(data.advice),
    blocks: normalizeBlocks(data.blocks),
    sources: notes.map((n) => ({ id: n.id, title: n.title })),
  }
}

/* ---------- 一致性检查（只读，不写盘） ---------- */

export async function auditNotes({ ids, cfg } = {}) {
  const notes = pickNotes(ids)
  if (notes.length < 2) throw new Error('至少要选两篇')
  const user = `要核对的笔记（[n] 是编号）：

${packNotes(notes)}`

  const text = await chat(
    [
      { role: 'system', content: systemFor('audit') },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.1, maxTokens: 4000 },
  )
  const data = pickJson(text)
  const byTitle = new Map(notes.map((n) => [str(n.title), n]))
  const one = (o) => {
    if (!o || typeof o !== 'object') return null
    const title = str(o.note)
    const quote = str(o.quote)
    if (!quote) return null
    const hit = byTitle.get(title)
    return { noteId: hit ? hit.id : '', note: title, quote }
  }
  const items = arr(data.items)
    .map((it) => {
      const kind = ['conflict', 'dupe', 'gap'].includes(it?.kind) ? it.kind : ''
      const a = one(it?.a)
      const b = one(it?.b)
      const why = str(it?.why)
      if (!kind || !a || !why) return null
      if (kind !== 'gap' && !b) return null
      return { kind, a, b, why, fix: str(it?.fix) }
    })
    .filter(Boolean)

  return { items, notes: notes.map((n) => ({ id: n.id, title: n.title, path: pathName(n.topicId) })) }
}

/* ---------- 原地重构：逐篇判断该精简 / 归段 / 拆篇，结果写回原篇 ---------- */

// 改动和新增默认勾上，删除和拆篇默认不勾 —— 抹内容、开新篇都是大动作，得人手点一下
const decorate = (ops) =>
  ops.map((o) => ({ ...o, checked: o.op === 'replace' || o.op === 'add' || o.op === 'move' }))

// 告诉模型「这批还有哪几篇」：撞车的内容该指过去，而不是自己再写一遍
// 同批用「」包、当前篇用《》包，两种括号区分开，模型不会把别人的标题当成自己的目标
const briefFor = (note, all, extra) => {
  const others = all.filter((n) => n.id !== note.id).map((n) => `「${n.title}」`)
  const lines = [
    `这一批一共 ${all.length} 篇一起过，现在只看《${note.title}》，只输出这一篇的改动。${others.length ? `同批还有 ${others.join('、')}，只用来对比撞车，不要改它们。` : ''}`,
    '目标是让这篇自己站得住：该归段的归段、重复的删掉、过长的块拆开；跟同批别的篇撞车的，删掉或改成 [[指向那篇]]。',
  ]
  if (extra) lines.push(`我的额外要求：${extra}`)
  return lines.join('\n')
}

// 一次只叫一篇：几篇的改动塞进一个 JSON 容易超长被截断，而且一篇失败不该连累别的
export async function reviseNotes({ ids, instruction = '', cfg, onProgress } = {}) {
  const notes = pickNotes(ids)
  if (!notes.length) throw new Error('先勾一篇以上')
  const out = []
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    if (onProgress) onProgress({ index: i + 1, total: notes.length, title: note.title })
    const row = {
      id: note.id,
      title: note.title,
      path: pathName(note.topicId),
      nextTitle: '',
      advice: '',
      ops: [],
      error: '',
    }
    try {
      const peers = notes
        .filter((n) => n.id !== note.id)
        .map((n) => ({
          id: n.id,
          title: n.title,
          path: pathName(n.topicId),
          text: noteText(n, { budget: 140 }).replace(/\n+/g, ' '),
        }))
      const r = await reviseNote({
        note,
        instruction: briefFor(note, notes, instruction),
        cfg,
        related: peers,
        allowSplit: true,
      })
      row.nextTitle = r.title
      row.advice = r.advice
      row.ops = decorate(r.ops)
    } catch (e) {
      row.error = String((e && e.message) || e)
    }
    out.push(row)
  }
  return out
}

// 落库：按每篇勾过的 ops 改写原篇，拆出去的部分另建新篇。返回撤销用的快照
export function commitRevises(items) {
  const undo = []
  const list = arr(items)
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const note = liveNoteById(it && it.id)
    if (!note) continue
    const rows = arr(it.ops).filter((o) => o.op === 'keep' || o.checked)
    if (!rows.some((o) => o.op !== 'keep')) continue
    const draft = { title: note.title, blocks: (note.blocks || []).map((b) => ({ ...b })) }
    const { splits } = applyOps(draft, rows)
    const before = rewriteNote(note.id, { title: it.nextTitle || note.title, blocks: draft.blocks })
    const made = []
    for (const s of splits.values()) {
      if (!s.blocks.length) continue
      const nn = createNote(topicExists(s.topicId) ? s.topicId : note.topicId)
      nn.title = stripMark(s.title).trim() || `${note.title}（续）`
      nn.blocks = idifyBlocks(s.blocks.map((b) => ({ ...b })))
      touchNote(nn)
      made.push(nn.id)
    }
    undo.push({ id: note.id, before, made })
  }
  return undo
}

// 撤销一次落库：原篇按快照还原，拆出来的新篇进回收站（不是真删，还能捞回来）
export function undoRevises(undo) {
  const list = arr(undo).slice().reverse()
  for (const u of list) {
    if (u.before) restoreNoteVersion(u.id, u.before)
    for (const id of arr(u.made)) removeNote(id)
  }
}

/* ---------- 跨笔记提问：先回答问题，再给一份能点的清单 ---------- */

// 模型要精确点到某一块，就得看见块 id：和 agent 的 read_note 同一套编号
const packForAsk = (notes) =>
  notes
    .map(
      (n, i) =>
        `[${i + 1}] 篇 id=${n.id}　《${n.title}》　位置：${pathName(n.topicId) || '未归类'}\n${noteText(n, {
          budget: 2600,
          ids: true,
        })}`,
    )
    .join('\n\n---\n\n')

const oneSec = (v) => (SECTIONS.some((s) => s.id === v) ? v : '')
// 抹内容、开新篇、并掉整篇都是大动作，默认不勾
const HEAVY = new Set(['drop', 'fold', 'split'])
const finger = (b) => blockText(b).replace(/\s+/g, '')

export function normalizePlan(data, notes) {
  const noteOf = new Map(notes.map((n) => [n.id, n]))
  const at = new Map()
  for (const n of notes) {
    for (const r of sectioned(n)) {
      at.set(r.block.id, { noteId: n.id, noteTitle: n.title, section: r.section, block: r.block })
    }
  }
  const out = []
  const used = new Set()
  const take = (id) => {
    const key = str(id)
    return at.has(key) && !used.has(key) ? { key, hit: at.get(key) } : null
  }

  for (const raw of arr(data && data.items)) {
    if (!raw || typeof raw !== 'object') continue
    const op = str(raw.op)
    const why = stripMark(str(raw.why))
    const base = { op, why, checked: !HEAVY.has(op), key: `${op}-${out.length}` }

    if (op === 'move') {
      const g = take(raw.id)
      const to = oneSec(str(raw.to))
      if (!g || !to || to === g.hit.section) continue
      used.add(g.key)
      out.push({ ...base, ...g.hit, blockId: g.key, to, checked: true })
      continue
    }

    if (op === 'drop') {
      const g = take(raw.id)
      if (!g) continue
      used.add(g.key)
      out.push({ ...base, ...g.hit, blockId: g.key })
      continue
    }

    if (op === 'merge') {
      const keep = take(raw.keep)
      const drop = take(raw.drop)
      if (!keep || !drop || keep.key === drop.key) continue
      used.add(keep.key)
      used.add(drop.key)
      // drop 那条才是动手的对象，keep 那条留在原地当「参照物」
      out.push({
        ...base,
        ...drop.hit,
        blockId: drop.key,
        to: keep.hit.section,
        otherId: keep.key,
        otherBlock: keep.hit.block,
        otherNoteId: keep.hit.noteId,
        otherNoteTitle: keep.hit.noteTitle,
        otherSection: keep.hit.section,
      })
      continue
    }

    if (op === 'reword') {
      const g = take(raw.id)
      if (!g) continue
      const to = oneSec(str(raw.to)) || g.hit.section
      const inner = raw.block && typeof raw.block === 'object' ? raw.block : raw
      const [next] = normalizeBlocks([{ ...inner, section: to }])
      if (!next) continue
      const { id: _id, ...block } = next
      used.add(g.key)
      out.push({ ...base, ...g.hit, blockId: g.key, to, next: block })
      continue
    }

    if (op === 'fold') {
      const from = noteOf.get(str(raw.from))
      const into = noteOf.get(str(raw.into))
      if (!from || !into || from.id === into.id) continue
      out.push({
        ...base,
        noteId: into.id,
        noteTitle: into.title,
        fromId: from.id,
        fromTitle: from.title,
      })
      continue
    }

    if (op === 'split') {
      const note = noteOf.get(str(raw.note))
      const title = stripMark(str(raw.title))
      if (!note || !title) continue
      const rows = sectioned(note).filter((r) => arr(raw.ids).map(str).includes(r.block.id))
      if (!rows.length) continue
      for (const r of rows) used.add(r.block.id)
      out.push({
        ...base,
        noteId: note.id,
        noteTitle: note.title,
        title,
        blockIds: rows.map((r) => r.block.id),
        blocks: rows.map((r) => ({ ...r.block })),
        sections: rows.map((r) => r.section),
      })
      continue
    }

    if (op === 'keep') {
      const note = noteOf.get(str(raw.note))
      if (!note) continue
      out.push({ ...base, noteId: note.id, noteTitle: note.title })
    }
  }
  return out
}

// 模型判 merge 时总会漏掉措辞不同的那几对：它读的是摘要，看不到「缩尾」和「截断」是一回事。
// 这里按字面相似度把跨篇的近似块两两挑出来，补成默认不勾的 merge 项，让人自己看一眼
const DUP_SIM = 0.72
function dupPairs(notes) {
  const rows = []
  for (const n of notes) {
    for (const r of sectioned(n)) {
      const t = flatOf(r.block)
      if (t) rows.push({ noteId: n.id, noteTitle: n.title, section: r.section, block: r.block, t })
    }
  }
  const out = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      if (a.noteId === b.noteId) continue
      const sim = pairScore(a.t, b.t)
      if (sim >= DUP_SIM) out.push({ keep: a, drop: b, sim })
    }
  }
  return out
}

// 已经出现在清单里的块不再补，免得同一条改动被列两次
function withDupMerge(items, notes) {
  const touched = new Set()
  for (const it of items) {
    if (it.blockId) touched.add(it.blockId)
    if (it.otherId) touched.add(it.otherId)
    for (const id of arr(it.blockIds)) touched.add(id)
  }
  const added = []
  for (const p of dupPairs(notes)) {
    if (touched.has(p.drop.block.id) || touched.has(p.keep.block.id)) continue
    touched.add(p.drop.block.id)
    added.push({
      op: 'merge',
      // 默认不勾：字面像不等于真重复，得人看一眼
      checked: false,
      key: `merge-auto-${added.length}`,
      why: `程序比对：两篇说法几乎一样（${Math.round(p.sim * 100)}% 重合）`,
      noteId: p.drop.noteId,
      noteTitle: p.drop.noteTitle,
      section: p.drop.section,
      block: p.drop.block,
      blockId: p.drop.block.id,
      to: p.keep.section,
      otherId: p.keep.block.id,
      otherBlock: p.keep.block,
      otherNoteId: p.keep.noteId,
      otherNoteTitle: p.keep.noteTitle,
      otherSection: p.keep.section,
    })
  }
  return added.length ? [...items, ...added] : items
}

export async function planCross({ ids, question = '', cfg } = {}) {
  const notes = pickNotes(ids)
  if (!notes.length) throw new Error('先勾一篇以上')
  const q = str(question).trim()
  if (!q) throw new Error('先写一句你要问的')
  const text = await chat(
    [
      { role: 'system', content: systemFor('cross') },
      { role: 'user', content: `我勾的笔记：\n\n${packForAsk(notes)}\n\n我要问的是：${q}` },
    ],
    { cfg, temperature: 0.15, maxTokens: 4000 },
  )
  const data = pickJson(text)
  return {
    question: q,
    // 模型爱把 [#块id] 抄进总结里，块 id 是给 items 用的，正文里不该出现
    answer: stripMark(str(data && data.answer)),
    items: withDupMerge(normalizePlan(data, notes), notes),
    notes: notes.map((n) => ({ id: n.id, title: n.title, path: pathName(n.topicId) })),
  }
}

/* ---------- 把勾中的清单落到库里 ---------- */

// 一篇笔记要改的行：按块原顺序铺一遍，没点到的原样 keep，这样段内次序不会乱
function rowsOf(note, ops) {
  const splitIds = new Set()
  for (const o of ops) if (o.op === 'split') for (const id of arr(o.ids)) splitIds.add(id)
  const touch = new Map()
  for (const o of ops) {
    if (o.op === 'split' || splitIds.has(o.id)) continue
    touch.set(o.id, o)
  }
  const rows = []
  for (const { block, section } of sectioned(note)) {
    if (splitIds.has(block.id)) continue
    const o = touch.get(block.id)
    if (!o) rows.push({ op: 'keep', id: block.id })
    else if (o.op === 'move') rows.push({ op: 'move', id: block.id, section: o.to, checked: true })
    else if (o.op === 'drop') rows.push({ op: 'drop', id: block.id, checked: true })
    else if (o.op === 'replace') {
      rows.push({ op: 'replace', id: block.id, section: o.section || section, block: o.block, checked: true })
    }
  }
  for (const o of ops) {
    if (o.op !== 'split') continue
    const picked = sectioned(note).filter((r) => arr(o.ids).includes(r.block.id))
    if (!picked.length) continue
    rows.push({
      op: 'split',
      to: { title: o.title, topicId: '', why: o.why },
      blocks: picked.map((r) => ({ ...r.block, section: r.section })),
      ids: picked.map((r) => r.block.id),
      checked: true,
    })
  }
  return rows
}

// 勾中的清单一次落库：先并篇（并完那篇就进回收站了），再逐篇改写。
// 返回撤销快照，交给 undoCross
export function commitCross(items) {
  const undo = { notes: [], restored: [], made: [] }
  const list = arr(items).filter((it) => it && it.checked && it.op !== 'keep')
  if (!list.length) return undo

  const gone = new Set()
  for (const it of list.filter((i) => i.op === 'fold')) {
    const from = liveNoteById(it.fromId)
    const into = liveNoteById(it.noteId)
    if (!from || !into || from.id === into.id || gone.has(from.id)) continue
    const kept = sectioned(into).map((r) => ({ ...r.block, section: r.section }))
    const have = new Set(kept.map(finger))
    const add = sectioned(from)
      .map((r) => ({ ...r.block, section: r.section }))
      .filter((b) => !have.has(finger(b)))
    const before = rewriteNote(into.id, { title: into.title, blocks: assembleBlocks([...kept, ...add]) })
    if (removeNote(from.id)) {
      gone.add(from.id)
      undo.restored.push(from.id)
    }
    undo.notes.push({ id: into.id, before, made: [] })
  }

  const perNote = new Map()
  const put = (noteId, o) => {
    if (!noteId || gone.has(noteId)) return
    if (!perNote.has(noteId)) perNote.set(noteId, [])
    perNote.get(noteId).push(o)
  }
  for (const it of list) {
    if (it.op === 'move') put(it.noteId, { op: 'move', id: it.blockId, to: it.to })
    else if (it.op === 'drop') put(it.noteId, { op: 'drop', id: it.blockId })
    else if (it.op === 'merge') put(it.noteId, { op: 'drop', id: it.blockId })
    else if (it.op === 'reword') put(it.noteId, { op: 'replace', id: it.blockId, section: it.to, block: it.next })
    else if (it.op === 'split') {
      put(it.noteId, { op: 'split', title: it.title, ids: it.blockIds, why: it.why })
    }
  }

  for (const [noteId, ops] of perNote) {
    const note = liveNoteById(noteId)
    if (!note) continue
    const rows = rowsOf(note, ops)
    if (!rows.some((r) => r.op !== 'keep')) continue
    const draft = { title: note.title, blocks: (note.blocks || []).map((b) => ({ ...b })) }
    const { splits } = applyOps(draft, rows)
    const before = rewriteNote(note.id, { title: note.title, blocks: draft.blocks })
    const made = []
    for (const s of splits.values()) {
      if (!s.blocks.length) continue
      const nn = createNote(topicExists(s.topicId) ? s.topicId : note.topicId)
      nn.title = stripMark(s.title).trim() || `${note.title}（续）`
      nn.blocks = idifyBlocks(s.blocks.map((b) => ({ ...b })))
      touchNote(nn)
      made.push(nn.id)
    }
    undo.notes.push({ id: note.id, before, made })
    undo.made.push(...made)
  }
  return undo
}

// 撤销：并掉的篇捞回回收站，改过的篇按快照还原，拆出来的新篇再进回收站
export function undoCross(undo) {
  const u = undo || {}
  for (const one of arr(u.notes).slice().reverse()) {
    if (one.before) restoreNoteVersion(one.id, one.before)
    for (const id of arr(one.made)) removeNote(id)
  }
  for (const id of arr(u.restored)) restoreNote(id)
}

/* ---------- 改动流水 ---------- 
   撤销快照不能只活在面板内存里：面板一关、或者切去笔记看一圈再回来，
   组件重新挂载，内存里的快照就没了，想反悔都没处点。
   这里把每次跨笔记写入连同「改之前」的快照一起存本机，历史里随时翻出来撤销。 */

const RUN_KEY = 'myknowledge.cross.runs'
const RUN_MAX = 12 // 历史最多留这么多次
const RUN_UNDO_MAX = 5 // 只有最近几次带完整快照，再往前只留记录，省着点本机存储

export const RUN_KIND = { plan: '清单写入', revise: '逐篇重构', ask: '问答归档' }

// 内容指纹：标题 + 各块文字折成一个短串，用来判断「这次改完之后，那篇有没有又被改过」
const sig = (note) => {
  const s = `${note.title}␟${(note.blocks || []).map((b) => blockText(b)).join('␟')}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}-${s.length}`
}

const slim = (lines) =>
  arr(lines)
    .map((s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160),
    )
    .filter(Boolean)
    .slice(0, 40)

// 超量的老记录把快照丢掉、只留一行账：记录还能看，只是不能再撤
const trimRuns = (list) => {
  let alive = 0
  return arr(list)
    .slice(0, RUN_MAX)
    .map((r) => {
      if (!r || !r.id) return null
      if (!r.undo || r.undoneAt) return r
      alive += 1
      return alive <= RUN_UNDO_MAX ? r : { ...r, undo: null, after: null }
    })
    .filter(Boolean)
}

function writeRuns(list) {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(trimRuns(list)))
  } catch {
    // 存不下就把老快照全丢掉再试一次；流水记不住不该让写入本身失败
    const lean = arr(list).map((r, i) => (i < 2 || !r ? r : { ...r, undo: null, after: null }))
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify(trimRuns(lean)))
    } catch {
      /* 本机存储满了，这次历史就留不住 */
    }
  }
}

export function loadRuns() {
  try {
    const v = JSON.parse(localStorage.getItem(RUN_KEY) || '[]')
    return Array.isArray(v) ? v.filter((r) => r && r.id) : []
  } catch {
    return []
  }
}

// 记一次写入：调用前已经落库，这里补上「改之后」的指纹和涉及哪几篇
export function logRun({ kind = 'plan', question = '', answer = '', lines = [], undo = null } = {}) {
  const u = undo || {}
  const after = {}
  const notes = []
  const any = (id) => state.notes.find((n) => n.id === id) || null
  for (const one of arr(u.notes)) {
    const n = liveNoteById(one.id)
    if (n) {
      after[n.id] = sig(n)
      notes.push({ id: n.id, title: n.title })
    }
    for (const id of arr(one.made)) {
      const nn = liveNoteById(id)
      if (!nn) continue
      after[nn.id] = sig(nn)
      notes.push({ id: nn.id, title: nn.title, made: true })
    }
  }
  // 并掉的篇这会儿已经在回收站里，得查全量
  for (const id of arr(u.restored)) {
    const n = any(id)
    if (n) notes.push({ id: n.id, title: n.title, trashed: true })
  }
  const hasUndo = arr(u.notes).length + arr(u.restored).length > 0
  const run = {
    id: `cr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    at: new Date().toISOString(),
    kind,
    question: String(question || '').trim().slice(0, 200),
    answer: String(answer || '').trim().slice(0, 1200),
    lines: slim(lines),
    notes,
    after,
    undo: hasUndo ? u : null,
    undoneAt: null,
  }
  writeRuns([run, ...loadRuns()])
  return run
}

// 撤销某一次：那几篇在这之后又被手改过的，先问一句再动手，别顺手把别的改动一起抹掉
export function undoRun(id, { force = false } = {}) {
  const list = loadRuns()
  const run = list.find((r) => r.id === id)
  if (!run) return { ok: false, reason: 'missing' }
  if (run.undoneAt) return { ok: false, reason: 'done' }
  if (!run.undo) return { ok: false, reason: 'gone' }
  const changed = []
  for (const [noteId, was] of Object.entries(run.after || {})) {
    const n = liveNoteById(noteId)
    if (n && sig(n) !== was) changed.push({ id: noteId, title: n.title })
  }
  if (changed.length && !force) return { ok: false, reason: 'changed', changed }
  undoCross(run.undo)
  writeRuns(
    list.map((r) =>
      r.id === id ? { ...r, undoneAt: new Date().toISOString(), undo: null, after: null } : r,
    ),
  )
  return { ok: true, changed }
}

// 只删这条账，不动笔记
export function forgetRun(id) {
  writeRuns(loadRuns().filter((r) => r.id !== id))
}

