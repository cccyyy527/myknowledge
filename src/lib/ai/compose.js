// L2 录入：一段乱笔记 → 分类 + 分块 + 归段；以及一次问答 → 归到哪篇

import { state, liveNotes } from '../store.js'
import { searchNotes } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, str, normalizeBlocks } from './schema.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { blockText } from './block-edit.js'
import { NO_FABRICATE_WRITE } from './prompts.js'

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

// 新建还是追加，唯一判据是「已有那篇的标题还概括得了这次内容吗」。
// 默认偏向复用：库里多一篇讲同一件事的笔记，比一篇什么都塞的大杂烩更难受——
// 用户搜的时候会命中两篇，读的时候还得自己比对哪篇更新。
export const FILE_RULE = `新建一篇，还是追加进已有的某一篇 —— 只按一条判据决定：那篇笔记的标题，换成这次的内容还成立吗？
- 成立（标题就是这个主题，或者那篇里的空小节 / 待补项正好是为这次的内容留的）→ 追加（exist / edit）。这是默认选项。
- 不成立（只是同一个大领域，把这次的标题换上去就不对了）→ 新建（new）。例：已有《CUPED 方差缩减》，这次讲的是「序贯检验的做法」，才该新建，不要塞进 CUPED 当一节。
- 这次内容本身能独立成篇、面试时会被单独拎出来问 → 新建，别硬塞进相邻那篇当个小节。
- 宁可追加到一篇略宽的标题下，也不要制造两篇讲同一件事的笔记：面试前一晚翻库，重复的两篇是要花时间分辨的。
- 别因为搜到一篇同名空骨架就放弃新建 —— 空骨架只有在标题确实对得上时才填；也别为了「避免重复」把两个不相干的主题硬合并。
- 判不出来就再读一遍候选那篇的小节：看它缺的正好是这次的内容，就追加。`

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

  const system = `你是数据分析面试知识库的归档助手。用户刚问了一个问题并拿到了回答，现在要把这次问答存进知识库。
你要同时决定两件事：
1. 该新建一篇笔记，还是追加进已有的某一篇。
${FILE_RULE}
2. 把回答重排成结构化知识块，按语义放对段落 —— 不要偷懒把整条答案原样塞进一张问答卡。
${BLOCK_SPEC}
${SECTION_SPEC}

额外要求：
- 回答里的 [1] [2] 这类引用编号原样保留，不要改号、不要新增；让它们落在 paragraph 的 text 或 qa 的 answer 里。
- 除了「面试官会怎么问」那种一句话提问，其余内容都拆成 paragraph / definition / formula / bulletList / steps / comparison。
- 回答整篇收进来，按内容顺成一条；不要标注哪句是引用、哪句是你自己补的，也不要留任何方括号标签或前缀。
- 回答里确实成立的通用知识可以收录，但${NO_FABRICATE_WRITE}
- 列表里只要有一篇笔记的标题能概括这次内容，就必须用 exist，不要因为「新建更干净」而新建。
- target 为 exist 时，noteId 必须原样复制笔记列表里出现过的 id，段落优先沿用那篇笔记已有的段落标题。
- target 为 new 时，topicId 必须原样复制分类树里出现过的 id；title 要短，不带书名号。
- target 为 new 时，nearNoteId 填你最犹豫「是不是该写进它」的那篇（必须是列表里的 id），nearNoteWhy 用一句话说清为什么放不进它。列表为空时这两个留空字符串。
- reason 用一句话说明为什么这么归类，会展示给用户看；新建时要把「和《某篇》比，差在哪」写进这句里。

只输出一个 JSON 对象：
{"target":"new|exist","title":"...","topicId":"...","noteId":"...","section":"core|detail|qa|pitfall|todo","reason":"...","nearNoteId":"...","nearNoteWhy":"...","blocks":[{"type":"...","section":"...",...}]}`

  const user = `分类树：\n${topicCatalog()}\n\n已有笔记（id｜标题｜位置｜段落｜开头）：\n${lines.join('\n') || '（还没有笔记）'}\n\n面试官会怎么问：\n${question}\n\n回答：\n${answer}`

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
