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
  BLOCK_SPEC,
  SECTION_SPEC,
  SECTIONS,
  str,
  arr,
  normalizeBlocks,
  assembleBlocks,
  stripMark,
} from './schema.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { NO_FABRICATE_WRITE } from './prompts.js'
import { reviseNote, applyOps, sectioned } from './revise.js'

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

const MERGE_SYSTEM = `你在整理一个数据分析面试知识库。用户挑了其中的几篇，要你把它们揉成一篇新的。

${BLOCK_SPEC}
${SECTION_SPEC}

要求：
- 不是把原文粘起来：重复的合并、散乱的重新归段、该并成一处的并成一处的。目标是「面试前只读这一篇也够」。
- 原文的结论、数字、公式、条件要原样搬，不许改口径；${NO_FABRICATE_WRITE}
- 几篇之间说法不一致时，不要自己挑一个：两边都写进块里并点明分歧，同时写进 advice。
- 原文里已经指向别篇的引用（[[标题]]）照留，别把被引的那篇的内容抄过来。
- 标题要能盖住这几篇的共同主题，短，不带书名号。
- 从给定分类树里挑最合适的一个分类填 topicId，必须原样复制树里出现过的 id，不要自己发明。
- 只输出一个 JSON 对象：
{"title":"...","topicId":"...","reason":"为什么这样合、哪几块是从哪篇来的","advice":"原文之间的冲突或明显缺口，一句话","blocks":[{"type":"...","section":"...",...}]}`

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
      { role: 'system', content: MERGE_SYSTEM },
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

const AUDIT_SYSTEM = `你在核对一个数据分析面试知识库里几篇笔记之间的一致性。只读检查，不改任何内容。

找三类问题：
- conflict 两处说法互相矛盾：同一个数字、条件、前提对不上，或者因果方向相反
- dupe     两处讲的是同一件事，只是换了措辞（面试前读会白费时间）
- gap      一篇里说「详见某篇」但那边其实没写，或者这组笔记里明显缺的一环

判据从严：只有真的会让人做出错误判断、或者会白读一遍，才算问题。用词不同、角度不同都不算。
每条必须带原文引用，照抄 12-40 字，不许改写、不许概括，否则用户翻不到。

只输出一个 JSON 对象：
{"items":[{"kind":"conflict","a":{"note":"笔记标题","quote":"原文照抄"},"b":{"note":"笔记标题","quote":"原文照抄"},"why":"一句话说清哪里对不上","fix":"一句话说怎么处理"}]}
gap 类没有 b，只给 a。`

export async function auditNotes({ ids, cfg } = {}) {
  const notes = pickNotes(ids)
  if (notes.length < 2) throw new Error('至少要选两篇')
  const user = `要核对的笔记（[n] 是编号）：

${packNotes(notes)}`

  const text = await chat(
    [
      { role: 'system', content: AUDIT_SYSTEM },
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

const ASK_SYSTEM = `你在看一个数据分析面试知识库里的几篇笔记，用户对它们提了一个问题。你要做两件事。

一、先回答（answer）。结论放第一句，两三句说完。不要说「这几篇各有侧重」这种不落地的话——要么说清哪里撞了、哪里缺了，要么说清都该留着、为什么。

${BLOCK_SPEC}
${SECTION_SPEC}

二、如果该动，给一份清单（items）。每条都要落到具体块上，不许写「建议精简」这种空话。id 一律从下面原文里原样抄，抄错整条作废。

能做的动作：
- move   {"op":"move","id":"块id","to":"core|detail|qa|pitfall|todo","why":"..."}   这块放错段了，挪到 to
- merge  {"op":"merge","keep":"块id","drop":"块id","why":"..."}                     两块讲的是同一件事：留 keep、删 drop（可以跨篇）
- reword {"op":"reword","id":"块id","to":"段id","block":{...},"why":"..."}          这块说法过时或有误：换成 block 这段（给全整块）
- drop   {"op":"drop","id":"块id","why":"..."}                                      这块是废话 / 重复 / 已被别处完全盖住
- fold   {"op":"fold","from":"篇id","into":"篇id","why":"..."}                      两篇其实是一篇：from 并进 into，from 整篇进回收站
- split  {"op":"split","note":"篇id","title":"新篇标题","ids":["块id"],"why":"..."}  这篇讲了两件事：ids 这几块拆成新篇
- keep   {"op":"keep","note":"篇id","why":"..."}                                    这篇不用动，说清留着它干什么

判据从严：
- 只有「读的人会因此判断错」或者「同一件事被读两遍」才算问题。用词不同、角度不同、深浅不同都不算。
- 段落放错算 move：名词解释塞进「高频问法」、公式占着「核心结论」、纯推导挤掉结论。
- 问「每篇都要留着吗」时：只有当 A 的内容被 B 基本盖住、留着只会让人两边翻，才 fold；A 里还有 B 没有的块就 keep。
- 别为了显得有用硬凑。没问题就 items 给空数组。

只输出一个 JSON 对象：
{"answer":"...","items":[...]}`

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
    const why = str(raw.why)
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

export async function planCross({ ids, question = '', cfg } = {}) {
  const notes = pickNotes(ids)
  if (!notes.length) throw new Error('先勾一篇以上')
  const q = str(question).trim()
  if (!q) throw new Error('先写一句你要问的')
  const text = await chat(
    [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: `我勾的笔记：\n\n${packForAsk(notes)}\n\n我要问的是：${q}` },
    ],
    { cfg, temperature: 0.15, maxTokens: 4000 },
  )
  const data = pickJson(text)
  return {
    question: q,
    answer: str(data && data.answer),
    items: normalizePlan(data, notes),
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

