// L3.5 agent：模型自己查、自己读、自己决定归档

import { liveNoteById } from '../store.js'
import { searchNotes, noteText, noteIsEmpty } from '../retrieve.js'
import { loadAI, isAiReady, chatStreamTools } from './client.js'
import { SECTIONS, str, normalizeBlocks, stripMark, OUTSIDE_MARK } from './schema.js'
import { planEdits } from './block-edit.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { FILE_RULE } from './compose.js'
import { trimHistory } from './ask.js'
import { NO_FABRICATE, NO_FABRICATE_WRITE } from './prompts.js'
import { buildSystem } from './skills.js'

/* ---------- L3.5：agent —— 模型自己查、自己读、自己归档 ---------- */

// 工具轮数上限：正常的问答 1～3 轮就够，6 轮还没收尾说明它在瞎转
export const MAX_ROUNDS = 6

const SECTION_IDS = ['core', 'detail', 'qa', 'pitfall', 'todo']

// 块的字段形状：blocks 和 edits 共用一份，别让两边漂走
const BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'paragraph',
        'definition',
        'formula',
        'comparison',
        'qa',
        'pitfall',
        'steps',
        'callout',
        'bulletList',
        'code',
        'todo',
      ],
    },
    section: { type: 'string', enum: SECTION_IDS },
    text: { type: 'string' },
    term: { type: 'string' },
    detail: { type: 'string' },
    latex: { type: 'string' },
    question: { type: 'string' },
    answer: { type: 'string' },
    cause: { type: 'string' },
    avoid: { type: 'string' },
    left: { type: 'string' },
    right: { type: 'string' },
    tone: { type: 'string', enum: ['tip', 'warn'] },
    items: { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { k: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
      },
    },
  },
  required: ['type', 'section'],
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        '在用户的知识库里按关键词检索笔记，返回 id、标题、分类路径、是否空笔记、开头一句。可以换不同说法多查几次。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，比如「CUPED 协变量」' },
          limit: { type: 'integer', description: '最多返回几篇，默认 6' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description:
        '读一篇笔记的完整正文（按小节分，每块前面带 [#块id]）。标题看起来对口时一定要读，不要只凭标题判断里面写了什么。要改已有内容时，块 id 就是改的目标。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'search_notes 返回的 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_topics',
      description: '列出知识库的分类树（domain / topic），归档新笔记时用来挑 topicId。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description:
        '提交一份归档提案（不会直接写盘，用户要确认）。只有用户让你存成笔记、或让你改已有笔记时才调用。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['new', 'exist', 'edit'],
            description:
              'new 新建一篇（已有笔记的标题概括不了这次内容时用它）；exist 往已有笔记对应小节末尾追加新块；edit 改已有笔记里具体的块（改写 / 删除 / 就地插入）',
          },
          noteId: {
            type: 'string',
            description: 'mode=exist / edit 时必填，必须在 search_notes / read_note 里出现过',
          },
          topicId: { type: 'string', description: 'mode=new 时必填，取自 list_topics' },
          title: { type: 'string', description: 'mode=new 时的笔记标题，要短，不带书名号' },
          section: {
            type: 'string',
            enum: SECTION_IDS,
            description: 'mode=exist 且不想按块分段落时，整段拼到哪一节末尾',
          },
          reason: { type: 'string', description: '一句话说明为什么这么归档，会展示给用户看' },
          blocks: {
            type: 'array',
            description: 'mode=new / exist 时的内容块，每块按语义放对 section',
            items: BLOCK_SCHEMA,
          },
          edits: {
            type: 'array',
            description:
              'mode=edit 时的改动列表。块 id 取自 read_note 输出里的 [#块id]，不要自己编。旧的结论过时就用 replace 改写，写错了就用 remove 删，缺一句就用 insert 就地补。',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['replace', 'remove', 'insert'],
                  description: 'replace 整块改写（要给全该块内容）；remove 删除该块；insert 在目标块后面插一块新的',
                },
                blockId: { type: 'string', description: 'op=replace / remove 时必填，目标是哪一块' },
                afterBlockId: { type: 'string', description: 'op=insert 时必填，插在这一块后面' },
                why: { type: 'string', description: '一句话说明这块为什么要改，会展示给用户看' },
                ...BLOCK_SCHEMA.properties,
              },
              required: ['op'],
            },
          },
        },
        required: ['mode', 'reason'],
      },
    },
  },
]

// 回答里的 [n] 按检索顺序编号：同一篇重复命中不重新编号
function citeIndex(ctx, note) {
  const at = ctx.refs.findIndex((r) => r.id === note.id)
  if (at >= 0) return at + 1
  ctx.refs.push({ id: note.id, title: note.title })
  return ctx.refs.length
}

function runTool(ctx, call) {
  const name = call.function?.name || ''
  let args = {}
  try {
    args = JSON.parse(call.function?.arguments || '{}') || {}
  } catch {
    args = {}
  }

  if (name === 'search_notes') {
    const q = str(args.query).trim()
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 6))
    const hits = q ? searchNotes(q, { limit }) : []
    if (!hits.length) {
      return {
        content: `「${q}」没有检索到相关笔记。可以换个说法再查（比如只用核心名词），或者用 list_topics 看都有哪些分类。`,
        summary: `🔍 查「${q}」→ 0 篇`,
      }
    }
    const lines = hits.map((h) => {
      const n = citeIndex(ctx, liveNoteById(h.id) || h)
      const flags = h.empty ? '｜空笔记（只有小节标题，没有正文）' : h.lead ? `｜开头：${h.lead}` : ''
      const tags = h.tags.length ? `｜标签：${h.tags.join('、')}` : ''
      return `[${n}] 《${h.title}》（id: ${h.id}）｜位置：${h.path}${flags}${tags}`
    })
    return {
      content: `找到 ${hits.length} 篇（编号用于回答里的 [n]）：\n${lines.join('\n')}`,
      summary: `🔍 查「${q}」→ ${hits.length} 篇`,
    }
  }

  if (name === 'read_note') {
    const note = liveNoteById(str(args.id))
    if (!note) {
      return { content: `没有 id 为 ${str(args.id)} 的笔记，用 search_notes 重新查。`, summary: '📖 读不到（id 不对）' }
    }
    const n = citeIndex(ctx, note)
    const empty = noteIsEmpty(note)
    return {
      content: `[${n}] ${noteText(note, { ids: true })}`,
      summary: `📖 读《${note.title}》→ ${empty ? '空笔记' : '正文'}`,
    }
  }

  if (name === 'list_topics') {
    return { content: `分类树：\n${topicCatalog()}`, summary: '🗂 看分类树' }
  }

  if (name === 'save_note') {
    const note = liveNoteById(str(args.noteId))

    // 改已有块：模型必须拿 read_note 给的块 id 当靶子，对不上的直接丢掉
    if (args.mode === 'edit') {
      if (!note) {
        return {
          content: `noteId「${str(args.noteId)}」对不上任何笔记。改已有笔记前先 search_notes 找到它、read_note 读出块 id，再提交。`,
          summary: '🗂 提案无效（noteId 不对）',
        }
      }
      const plan = planEdits(note, args.edits)
      if (!plan.changed.length) {
        const miss = plan.skipped.map((x) => `${x.op} ${x.id || '（没给 id）'}`).join('、')
        return {
          content: `没有一条改动对得上《${note.title}》里的块（${miss || 'edits 是空的'}）。块 id 只能取自 read_note 输出里的 [#块id]，不要自己编；先 read_note 再改。`,
          summary: '🗂 提案无效（块 id 对不上）',
        }
      }
      ctx.proposal = {
        target: 'edit',
        noteId: note.id,
        noteTitle: note.title,
        reason: stripMark(str(args.reason)),
        edits: plan.changed,
        blocks: plan.blocks,
        skipped: plan.skipped,
      }
      const n = plan.changed.length
      const drop = plan.skipped.length ? `，另有 ${plan.skipped.length} 处对不上被丢掉` : ''
      return {
        content: `提案已记录：改《${note.title}》${n} 处${drop}。用户会看到改动前后的对照，可以改也可以取消——不要再提交一遍，也不要在正文里复述。`,
        summary: `🗂 改《${note.title}》${n} 处`,
      }
    }

    const blocks = normalizeBlocks(args.blocks)
    if (!blocks.length) {
      return {
        content: 'blocks 为空或不合法，提案没有记录。请重新调用 save_note，给出至少一个真正有内容的块。',
        summary: '🗂 提案无效（blocks 为空）',
      }
    }
    const oldNote = liveNoteById(str(args.noteId))
    const mode = args.mode === 'exist' && oldNote ? 'exist' : 'new'
    const topicId = mode === 'exist' ? oldNote.topicId : topicExists(args.topicId) ? args.topicId : fallbackTopicId()
    ctx.proposal = {
      target: mode,
      title: str(args.title),
      topicId,
      noteId: mode === 'exist' ? oldNote.id : '',
      section: SECTIONS.some((s) => s.id === args.section) ? args.section : blocks[0].section || 'core',
      reason: stripMark(str(args.reason)),
      blocks,
    }
    const where =
      mode === 'exist'
        ? `写进《${oldNote.title}》${blocks.length} 块`
        : `新建《${str(args.title) || '未命名'}》${blocks.length} 块`
    return {
      content: `提案已记录：${where}。用户可以改也可以取消——不要再提交一遍，也不要在正文里复述这些块。`,
      summary: `🗂 归档：${where}`,
    }
  }

  return { content: `没有叫 ${name} 的工具。`, summary: `⚠ 未知工具 ${name}` }
}

// agent 循环：有 tool_call 就执行工具接着问，没有了就是最终回答
export async function agentRun({
  messages,
  cfg,
  strict = false,
  refs = [],
  maxTokens = 2000,
  onDelta,
  onThink,
  onTrace,
  signal,
} = {}) {
  if (!isAiReady(cfg || loadAI())) throw new Error('还没填 API Key，先到「设置」里配一下')
  const msgs = [...messages]
  const ctx = { refs: refs.map((r) => ({ ...r })), proposal: null }
  const call = (extra) =>
    chatStreamTools(msgs, {
      cfg,
      tools: TOOLS,
      temperature: strict ? 0.1 : 0.25,
      maxTokens,
      onDelta,
      onThink,
      signal,
      ...extra,
    })
  let answer = ''
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { text, toolCalls, reasoning } = await call()
    if (!toolCalls.length) {
      answer = text
      msgs.push({ role: 'assistant', content: text })
      break
    }
    const am = {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: c.function })),
    }
    // DeepSeek 开思考时，带 tools 的下一轮必须原样回传 reasoning_content，否则 400
    if (reasoning) am.reasoning_content = reasoning
    msgs.push(am)
    for (const c of toolCalls) {
      const out = runTool(ctx, c)
      onTrace && onTrace(out.summary)
      msgs.push({ role: 'tool', tool_call_id: c.id, content: out.content })
    }
  }
  // 轮数用尽时再要一轮，这次不许调工具：拿已经查到的材料给个答案，比直接报错有用得多
  if (!answer) answer = (await call({ toolChoice: 'none' })).text
  if (!answer) throw new Error(`模型查了 ${MAX_ROUNDS} 轮还没给出答案，换个问法试试`)
  return { text: answer, refs: ctx.refs, proposal: ctx.proposal, messages: msgs }
}

const AGENT_RULES = `你是这个私人知识库的 agent。用户是准备数据分析 / AB 实验 / 因果推断面试的人，库里是他自己写的笔记——其中有些笔记只有小节标题、正文还是空的。

你能调用工具：search_notes 检索、read_note 读整篇、list_topics 看分类、save_note 提交归档提案。

怎么用工具：
- 先 search_notes，可以换 2～3 种说法反复查，别查一次没中就下结论。
- 结果里标题看着对口的，一定 read_note 打开看正文，不要凭标题猜里面写了什么。
- 来自笔记的具体结论后面标 [n]，n 必须是工具返回的那些编号，不要自己另编号。`

const AGENT_ANSWER = `

回答怎么写：
- 先给结论，再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。
- 笔记里有：就按笔记讲，讲完停。
- 笔记里没有、但你确实知道的：另起一段，段首单独占一行写「${OUTSIDE_MARK}」，把该讲的内容讲清楚、讲完整；整段讲完，最多用一句话说明库里哪篇最接近、还缺什么。不要把「库里缺什么」写在开头当成答案。这个标记是给程序切段用的，渲染时会被去掉：不要解释它、不要重复它、也不要写进 save_note 的块里。
- read_note 显示某篇只有小节标题没有正文时，就说「库里那篇《X》还是空的」。它的标题只能当成「这个话题还打算写」，不能当成已有结论引用。
- ${NO_FABRICATE}
- 用户问「有哪些 / 列一下」时，把查到的都列出来，一条一行，每条带 [n]。
- 库里另有笔记专门讲这件事时，用 [[那篇的完整标题]] 指过去（标题必须和工具返回的完全一致），别把整篇内容抄过来。
- 笔记之间说法冲突时，指出是哪两篇、各自怎么写，别替他打圆场。
- 用户问的这件事如果正好是某篇里某一段写错了、写漏了，直接说清是哪一篇哪一块该怎么改；他让你改的时候用 save_note 的 mode=edit 提改动。
- 除了 [n] 和 [[标题]]，不要再出现别的方括号标记、标签或前缀。
- 除非用户明确让你存成笔记或改笔记，否则不要调用 save_note。`

const AGENT_STRICT = `${AGENT_RULES}

只查笔记模式（用户面试前怕被带偏，一个字都不许超出笔记）：
- 只能依据 read_note / search_notes 拿到的内容回答，每条具体结论都带 [n]。
- 禁止用你自己的通用知识补充，禁止写「${OUTSIDE_MARK}」段落，禁止编造数字、论文名、公司案例。
- 笔记里没写的直接说「库里还没有」，再说最接近哪一篇、缺什么，然后就停。
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。`

// history 只放最近几轮问答，别把整段对话灌进去
export function askAgent({ question, history = [], cfg, strict = false, skill, extra, ...rest } = {}) {
  const base = strict ? AGENT_STRICT : AGENT_RULES + AGENT_ANSWER
  const messages = [
    { role: 'system', content: buildSystem(base, { skill, extra }) },
    ...trimHistory(history),
    { role: 'user', content: question },
  ]
  return agentRun({ messages, cfg, strict, ...rest })
}

const ARCHIVE_NUDGE = `把上面这轮问答存进知识库：
- 先 search_notes 查有没有同主题的笔记，再决定是新建还是追加。
${FILE_RULE}
- 追加进已有笔记时，需要的话 read_note 看它已有的小节和块 id。
- 然后调用 save_note 提交提案：mode、noteId 或 topicId、reason，以及 blocks 或 edits。
- 这轮回答如果是在纠正、补充、更新已有块里的说法，用 mode=edit：edits 里逐条写 op（replace 整块改写 / remove 删除 / insert 在目标块后就地插一块），blockId 取自 read_note 的 [#块id]，块内容要给全。
- 纯粹是新内容才用 mode=exist 往小节末尾追加 blocks。
- blocks 要按语义分块（paragraph / definition / formula / qa / pitfall / steps / comparison），别把整篇答案塞进一张问答卡。
- 回答里的 [1] [2] 这些编号原样保留。
- 上面这轮回答整篇收进来：按内容顺成一条，不要标注哪句是引用、哪句是你自己补的，也不要留任何方括号标签或前缀。
- 笔记里没有、但确实成立的通用知识可以写进来，写清楚成立条件和结论就行。${NO_FABRICATE_WRITE}
- 内容牵涉库里别的笔记时，写 [[那篇的完整标题]]，标题必须和工具返回的一字不差；不确定就不写。
- 这里的回答是给归档器看的，不用长篇解释；提案提交完说一句归档到哪了就停。`

// 沿着问答那轮的同一个会话往下走：模型还记着刚才查过什么，判断更准
export function archiveAgent({ messages, refs = [], cfg, onTrace, signal } = {}) {
  const next = [...messages, { role: 'user', content: ARCHIVE_NUDGE }]
  return agentRun({ messages: next, refs, cfg, maxTokens: 2000, onTrace, signal })
}
