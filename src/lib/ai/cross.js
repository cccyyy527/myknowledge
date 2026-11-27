// 跨笔记：把一组笔记揉成一篇新的（原篇一块都不动），或者只读地查它们之间的说法冲突

import { state, liveNoteById } from '../store.js'
import { noteText } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import { BLOCK_SPEC, SECTION_SPEC, str, arr, normalizeBlocks } from './schema.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { NO_FABRICATE_WRITE } from './prompts.js'

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
