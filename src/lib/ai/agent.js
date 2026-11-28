// L3.5 agent：模型自己查、自己读、自己决定归档

import { liveNoteById } from '../store.js'
import { searchNotes, noteText, noteIsEmpty, noteBrief } from '../retrieve.js'
import { loadAI, isAiReady, thinkOn, chatStreamTools } from './client.js'
import { SECTIONS, str, normalizeBlocks, stripMark, sectionDumpIssue } from './schema.js'
import { planEdits, dupBlocks, dupIssue } from './block-edit.js'
import { reviewWrite, sameIssue, writeChecks } from './place.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'
import { trimHistory } from './ask.js'
import { systemFor } from './skills/index.js'

/* ---------- L3.5：agent —— 模型自己查、自己读、自己归档 ---------- */

// 工具轮数上限：正常的问答 1～3 轮就够。归档那步会额外做一次程序复核、
// 可能打回重来一次，所以留得比从前宽，但只要绕圈就要收
export const MAX_ROUNDS = 10

// 打回的总次数上限：复核能救人，也能把轮数全烧在同一个错误上
const MAX_BOUNCE = 3

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
    section: {
      type: 'string',
      enum: SECTION_IDS,
      description:
        '这块归到哪一节（按内容语义，不按内容来源）：core 核心结论＝只放能追问「凭什么」的断言；detail 推导/细节＝公式、前提、无偏性、与替代方案的对比；qa 高频问法＝只有「面试官原话 + 我怎么答」的问答卡才放这里；pitfall 我踩过的坑＝真答错过做错过的事 + 怎么改；todo 还没查清的占位。',
    },
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
            enum: ['exist', 'edit', 'new'],
            description:
              'exist 往已有笔记对应小节末尾追加新块（库里已有笔记能装下这次内容就用它；但这次要说的内容那篇里已经写了就别用它，见 edit）；edit 改已有笔记里具体的块（改写 / 删除 / 就地插入 / 把放错段的块挪回去）；new 新建一篇（只有已有笔记的标题换不掉、或者这次是全新主题时才用，且必须填 nearNoteId 交代你放弃了哪篇）',
          },
          noteId: {
            type: 'string',
            description: 'mode=exist / edit 时必填，必须在 search_notes / read_note 里出现过',
          },
          topicId: { type: 'string', description: 'mode=new 时必填，取自 list_topics' },
          title: { type: 'string', description: 'mode=new 时的笔记标题，要短，不带书名号' },
          nearNoteId: {
            type: 'string',
            description:
              'mode=new 时必填：你最犹豫「是不是该写进它」的那篇（取自 search_notes 的 id）。用户会在面板上一键切过去，所以别敷衍——真读过它再填。库里一篇候选都没有时留空。',
          },
          nearNoteWhy: {
            type: 'string',
            description: 'mode=new 时用一句话说清：为什么这次内容放进上面那篇不合适（标题换了就不成立 / 面试会单独问 / 那篇已经专讲别的角度）。',
          },
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
              'mode=edit 时的改动列表。块 id 取自 read_note 输出里的 [#块id]，不要自己编。旧的结论过时就用 replace 改写，写错了就用 remove 删，缺一句就用 insert 就地补；这篇其实写过、只是段落放错了，用 move 把它挪回去——别在 exist 里再加一块一样的。',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['replace', 'remove', 'insert', 'move'],
                  description:
                    'replace 整块改写（要给全该块内容）；remove 删除该块；insert 在目标块后面插一块新的；move 只把该块挪到 section 指定的段落，内容一个字不改（不用给块内容）',
                },
                blockId: { type: 'string', description: 'op=replace / remove / move 时必填，目标是哪一块' },
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

async function runTool(ctx, call) {
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
      const stat = h.empty
        ? ''
        : `｜已有 ${h.count} 块${h.sections.length ? `：${h.sections.map((s) => `${s.title || '（无小节）'} ${s.n}`).join('、')}` : ''}`
      ctx.seen.set(h.id, h)
      return `[${n}] 《${h.title}》（id: ${h.id}）｜位置：${h.path}${stat}${flags}${tags}`
    })
    const hint = ctx.seen.size
      ? '\n要归档时：这几篇里只要有一篇的标题能概括这次内容，就该并进去（exist / edit），别另起一篇重复的。'
      : ''
    return {
      content: `找到 ${hits.length} 篇（编号用于回答里的 [n]）：\n${lines.join('\n')}${hint}`,
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
    ctx.read.add(note.id)
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
    // 段落归位是硬要求：整条答案都标 qa 等于把断言、推导全降级成问答卡，
    // 那篇笔记的「核心结论」会一直是空的
    const dump = sectionDumpIssue(blocks)
    if (dump) {
      return {
        content: `${dump}\n重新调用 save_note，块内容可以照搬，只把 section 改对。`,
        summary: '🗂 打回：段落和块类型对不上',
      }
    }
    const oldNote = liveNoteById(str(args.noteId))
    const mode = args.mode === 'exist' && oldNote ? 'exist' : 'new'
    // 这次要加的东西这篇里已经有了：正解是把那一块归位或改写，不是再抄一份
    if (mode === 'exist') {
      const dup = dupBlocks(oldNote, blocks)
      if (dup.length) return { content: dupIssue(dup), summary: `🗂 打回：${dup.length} 块这篇已有` }
    }

    // 程序复核：跟库里其它篇（和目标这篇的近似块）比一遍，顺带判「该不该写在这儿」。
    // 模型看不到别篇已经写了什么，这一层不补，「同义改写漏检」和「总想新建」都治不了
    const review = await reviewWrite({
      blocks,
      chosenId: mode === 'exist' ? oldNote.id : '',
      cfg: ctx.cfg,
      signal: ctx.signal,
    })
    const targetId = mode === 'exist' ? oldNote.id : ''
    const same = review.dup.filter((x) => x.v === 'same')
    if (same.length && ctx.bounce < MAX_BOUNCE) {
      ctx.bounce += 1
      return {
        content: sameIssue(same, targetId),
        summary: `🗂 打回：库里已有同一件事（${same.length} 处）`,
      }
    }
    // 只是部分重叠：不拦，写在面板上让人自己决定要不要合并
    const soft = review.dup.filter((x) => x.v === 'part')
    // 程序检索出来的「更像该写进去的那篇」：和模型选的不一样才拿出来说
    const better =
      review.place && review.place.noteId && review.place.noteId !== targetId
        ? liveNoteById(review.place.noteId)
        : null

    const nearId = str(args.nearNoteId)
    const near = nearId ? liveNoteById(nearId) : null

    // 新建是最省事但也最容易造重复的选项。库里查到过候选、却没读过任何一篇就新建，
    // 一律打回：先看一遍再决定，这是「总是倾向新建」的主要来源。
    if (mode === 'new' && ctx.seen.size && ctx.bounce < MAX_BOUNCE) {
      if (!near) {
        const cands = [...ctx.seen.values()]
          .sort((a, b) => b.count - a.count)
          .map((h) => `- 《${h.title}》（id: ${h.id}）${h.empty ? '空笔记' : `已有 ${h.count} 块`}`)
          .join('\n')
        ctx.bounce += 1
        return {
          content: `库里查到过这些相关笔记，你不能直接新建：\n${cands}\n先 read_note 读最接近的那篇，然后二选一——能装下就改成 mode=exist / edit；确实装不下就继续 new，但要把那篇填进 nearNoteId，并在 nearNoteWhy 里说清为什么放不进它。`,
          summary: '🗂 打回：新建前没读候选笔记',
        }
      }
      if (!ctx.read.has(near.id)) {
        ctx.bounce += 1
        return {
          content: `nearNoteId 指向《${near.title}》，但你这一轮没读过它的正文。先 read_note（id: ${near.id}）看清楚它已经写了什么，再回答「这次内容放进去合不合适」。`,
          summary: `🗂 打回：没读《${near.title}》就判它不合适`,
        }
      }
    }
    // agent 压根没搜过库：程序按这次内容检索出来的那篇，就是它该先看的那篇
    if (mode === 'new' && !ctx.seen.size && better && ctx.bounce < MAX_BOUNCE) {
      ctx.bounce += 1
      return {
        content: `你要新建一篇，但按这次内容在库里检索，最接近的是《${better.title}》（id: ${better.id}）。先 read_note 看它已经写了什么：能装下就改成 mode=exist / edit 写进去；确实装不下再继续 new，并把 nearNoteId 填 ${better.id}、nearNoteWhy 一句话说清为什么它装不下。`,
        summary: `🗂 打回：没看《${better.title}》就新建`,
      }
    }

    const topicId = mode === 'exist' ? oldNote.topicId : topicExists(args.topicId) ? args.topicId : fallbackTopicId()
    // 用户能不能一眼看出「其实还有更好的落点」，全靠这一对：新建时是模型放弃的那篇，
    // 追加时是程序检索觉得更像的那篇
    const altNote = mode === 'new' ? near : better
    const alt =
      altNote && altNote.id !== (mode === 'exist' ? oldNote.id : '')
        ? {
            noteId: altNote.id,
            noteTitle: altNote.title,
            why: stripMark(str(mode === 'new' ? args.nearNoteWhy : review.place?.why)),
          }
        : null
    const checks = writeChecks(blocks, { note: mode === 'exist' ? oldNote : null, soft })
    ctx.proposal = {
      target: mode,
      title: str(args.title),
      topicId,
      noteId: mode === 'exist' ? oldNote.id : '',
      section: SECTIONS.some((s) => s.id === args.section) ? args.section : blocks[0].section || 'core',
      reason: stripMark(str(args.reason)),
      blocks,
      alt,
      checks,
    }
    const where =
      mode === 'exist'
        ? `写进《${oldNote.title}》${blocks.length} 块`
        : `新建《${str(args.title) || '未命名'}》${blocks.length} 块`
    const extra = [alt ? `备选落点《${alt.noteTitle}》` : '', checks.length ? `${checks.length} 条复核提示` : '']
      .filter(Boolean)
      .join('；')
    return {
      content: `提案已记录：${where}${extra ? `（${extra} 会一并给用户看）` : ''}。用户可以改也可以取消——不要再提交一遍，也不要在正文里复述这些块。`,
      summary: `🗂 归档：${where}${checks.length ? `（${checks.length} 条提示）` : ''}`,
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
  const conf = cfg || loadAI()
  const msgs = [...messages]
  // 问答那轮已经引用过的笔记算「查过也读过」：续聊时模型不会重搜一遍，
  // 不预先灌进来会把它已经看过的候选当成没看过而打回
  const cited = refs.map((r) => ({ id: r.id, note: liveNoteById(r.id) })).filter((x) => x.note)
  const ctx = {
    refs: refs.map((r) => ({ ...r })),
    proposal: null,
    seen: new Map(cited.map((x) => [x.id, noteBrief(x.note, 0)])),
    read: new Set(cited.map((x) => x.id)),
    // 写库复核要用的东西：模型配置、外部取消、以及「打回得了几次」的计数
    cfg: conf,
    signal,
    bounce: 0,
  }
  // 思考开关一旦降级或这一轮没产出思考内容，后面就一路关着：历史里的 assistant 消息已经
  // 缺 reasoning_content，DeepSeek 在思考模式下会因此直接 400，补不回来了
  let think = thinkOn(conf)
  const call = (extra) =>
    chatStreamTools(msgs, {
      cfg: think ? conf : { ...conf, thinking: 'off' },
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
    const { text, toolCalls, reasoning, thinking } = await call()
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
    if (thinking && reasoning) am.reasoning_content = reasoning
    if (!(thinking && reasoning)) think = false
    msgs.push(am)
    for (const c of toolCalls) {
      const out = await runTool(ctx, c)
      onTrace && onTrace(out.summary)
      msgs.push({ role: 'tool', tool_call_id: c.id, content: out.content })
    }
  }
  // 轮数用尽时再要一轮，这次不许调工具：拿已经查到的材料给个答案，比直接报错有用得多
  if (!answer) answer = (await call({ toolChoice: 'none' })).text
  if (!answer) throw new Error(`模型查了 ${MAX_ROUNDS} 轮还没给出答案，换个问法试试`)
  return { text: answer, refs: ctx.refs, proposal: ctx.proposal, messages: msgs }
}

// history 只放最近几轮问答，别把整段对话灌进去
export function askAgent({ question, history = [], cfg, strict = false, skill, extra, ...rest } = {}) {
  const messages = [
    { role: 'system', content: systemFor(strict ? 'agent-strict' : 'agent', { role: skill, extra }) },
    ...trimHistory(history),
    { role: 'user', content: question },
  ]
  return agentRun({ messages, cfg, strict, ...rest })
}

// 沿着问答那轮的同一个会话往下走：模型还记着刚才查过什么，判断更准。
// 但 system 必须换掉重来 —— 上一轮可能是「出题官」，那套人设留在归档轮里会和这一轮真正要做的事抢注意力
export function archiveAgent({ messages = [], refs = [], cfg, onTrace, signal } = {}) {
  const kept = messages.filter((m) => m.role !== 'system')
  const next = [
    { role: 'system', content: systemFor('archive') },
    ...kept,
    { role: 'user', content: '把上面这轮问答存进知识库。' },
  ]
  return agentRun({ messages: next, refs, cfg, maxTokens: 2000, onTrace, signal })
}
