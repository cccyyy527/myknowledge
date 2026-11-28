// L2 录入：一段乱笔记 → 分类 + 分块 + 归段；以及一次问答 → 归到哪篇

import { state, liveNotes } from '../store.js'
import { searchNotes } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, str, normalizeBlocks, sectionDumpIssue } from './schema.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { blockText } from './block-edit.js'
import { systemFor } from './skills/index.js'

/* ---------- L2：一段乱笔记 → 分类 + 分块 + 归段 ---------- */

export async function composeNote(raw, cfg) {
  const system = `你是数据分析面试知识库的录入助手。用户会粘贴一段零散的笔记，你要把它整理成结构化知识。
${BLOCK_SPEC}
${SECTION_SPEC}

要求：
- 从给定分类树里挑最合适的一个分类，把它的 id 填到 topicId。必须原样复制树里出现过的 id，不要自己发明。都不合适就挑最接近的，并在 reason 里说明。
- title 是这篇笔记的标题，短，不要带书名号。
- 不要编造用户没给的事实、数字、案例；缺信息就用 todo 块占位。
- 只输出一个 JSON 对象，格式：
{"title":"...","topicId":"...","reason":"...","blocks":[{"type":"...","section":"...",...}]}`

  const user = `分类树：\n${topicCatalog()}\n\n待整理内容：\n${raw}`
  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.2, maxTokens: 4000 },
  )
  const data = pickJson(text)
  return {
    title: str(data.title) || '未命名笔记',
    topicId: topicExists(data.topicId) ? data.topicId : fallbackTopicId(),
    recommended: str(data.topicId),
    reason: str(data.reason),
    blocks: normalizeBlocks(data.blocks),
  }
}

/* ---------- L2.5：一次问答 → 归档判断（新建 / 追加 + 分块） ---------- */

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

// 给模型看的笔记摘要：段落标题 + 开头一句，够它判断「是不是同一个主题」
function noteDigest(note) {
  const blocks = note.blocks || []
  const heads = blocks
    .filter((b) => b.type === 'heading' && b.level === 2 && b.text)
    .map((b) => b.text)
  const lead = blocks.filter((b) => b.type !== 'heading').map(blockText).find(Boolean) || ''
  return { heads, lead: lead.slice(0, 70) }
}

// 新建还是追加、怎么分块，判据在 skills/archive.md 里；这里只补这段代码自己的输出契约。
// 早先这里有一份 FILE_RULE 常量，和归档 prompt 各说一遍同一个判据，改一处忘一处就会前后打架。

export async function fileAnswer({ question, answer, used = [], cfg, signal } = {}) {
  const notes = liveNotes()
  const MAX_DIGEST_NOTES = 100 // 归档时最多列这么多篇给模型挑，再多它也读不过来，只会稀释注意力
  const picked = []
  const seen = new Set()
  const take = (n) => {
    if (!n || seen.has(n.id)) return
    seen.add(n.id)
    picked.push(n)
  }
  // 引用过的笔记排最前：这次问答大概率跟它们同主题
  for (const s of used) take(notes.find((x) => x.id === s.id))
  // 其次是检索命中的：真正该「追加进去」的那篇往往在这里，
  // 别让它因为数组顺序靠后而被截断掉，逼着模型去新建一篇重复的
  for (const hit of searchNotes(question, { limit: 30 })) take(notes.find((x) => x.id === hit.id))
  for (const n of notes) {
    if (picked.length >= MAX_DIGEST_NOTES) break
    take(n)
  }
  const lines = picked.map((n) => {
    const { heads, lead } = noteDigest(n)
    const parts = [
      n.id,
      n.title,
      pathName(n.topicId) || '未分类',
      `段落：${heads.join('、') || '（还没分段）'}`,
    ]
    if (lead) parts.push(`开头：${lead}`)
    return `- ${parts.join('｜')}`
  })

  const system = `${systemFor('archive')}

## 这一轮的输出形状

上面是判断标准，这一轮的输出是**一个 JSON 对象**，不要写任何解释性文字：
{"target":"new|exist","title":"...","topicId":"...","noteId":"...","section":"core|detail|qa|pitfall|todo","reason":"...","nearNoteId":"...","nearNoteWhy":"...","blocks":[{"type":"...","section":"...",...}]}

- 回答里的 [1] [2] 这类引用编号原样保留，不要改号、不要新增；让它们落在 paragraph 的 text 或 qa 的 answer 里。
- 除了真正写成「面试官会这么问 + 我怎么答」的问答卡，其余内容都拆成 paragraph / definition / formula / bulletList / steps / comparison。
- 每块的 section 按内容语义定，跟这次内容是从一个问答来的无关：别因为用户「问了个问题」就把整条答案都标成 qa。
- 回答整篇收进来，按内容顺成一条；不要标注哪句是引用、哪句是你自己补的，也不要留任何方括号标签或前缀。
- 列表里只要有一篇笔记的标题能概括这次内容，就必须用 exist，不要因为「新建更干净」而新建。
- target 为 exist 时，noteId 必须原样复制笔记列表里出现过的 id，段落优先沿用那篇笔记已有的段落标题。
- target 为 new 时，topicId 必须原样复制分类树里出现过的 id；title 要短，不带书名号。
- target 为 new 时，nearNoteId 填你最犹豫「是不是该写进它」的那篇（必须是列表里的 id），nearNoteWhy 用一句话说清为什么放不进它。列表为空时这两个留空字符串。
- reason 用一句话说明为什么这么归类，会展示给用户看；新建时要把「和《某篇》比，差在哪」写进这句里。`

  const user = `分类树：\n${topicCatalog()}\n\n已有笔记（id｜标题｜位置｜段落｜开头）：\n${lines.join('\n') || '（还没有笔记）'}\n\n用户这次问的问题：\n${question}\n\n回答：\n${answer}`

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.2, maxTokens: 4000, signal },
  )
  const data = pickJson(text)
  const blocks = normalizeBlocks(data.blocks)
  if (!blocks.length) throw new Error('模型没切出可用的内容，重试一次')
  // 跟 agent 那条路径同一道闸：整条答案全标 qa 等于断言和推导都没归位
  const dump = sectionDumpIssue(blocks)
  if (dump) throw new Error(dump)

  const noteId = str(data.noteId)
  const target = data.target === 'exist' && notes.some((n) => n.id === noteId) ? 'exist' : 'new'
  const section = SECTIONS.some((s) => s.id === data.section) ? data.section : blocks[0].section || 'core'
  // 新建时把「本来也能写进哪篇」带出来，面板上一键就能改投，
  // 不然用户只能看到「又是新建」，还得自己去找该并到哪
  const near = target === 'new' ? notes.find((n) => n.id === str(data.nearNoteId)) : null
  return {
    target,
    title: str(data.title),
    topicId: topicExists(data.topicId) ? data.topicId : fallbackTopicId(),
    noteId: target === 'exist' ? noteId : '',
    section,
    reason: str(data.reason),
    blocks,
    alt: near ? { noteId: near.id, noteTitle: near.title, why: str(data.nearNoteWhy) } : null,
  }
}
