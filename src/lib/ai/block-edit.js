// 改块：单个块的润色 / 扩写 / 拆块，以及按块 id 改写整篇里的若干块

import { chatStreamTools, loadAI, thinkOn, trimThread, settleThread } from './client.js'
import {
  SECTIONS,
  BLOCK_SPEC,
  SECTION_SPEC,
  str,
  arr,
  bid,
  VALID,
  normalizeBlocks,
  stripSection,
  stripMark,
  SEC_IDS,
  secOk,
  BLOCK_ARG,
  AFTER_ARG,
} from './schema.js'
import { NO_FABRICATE_WRITE } from './prompts.js'

/* ---------- 改已有块：按块 id 改写 / 删除 / 就地插入 ---------- */

// 模型给的补丁 → 一个完整的新块；老块的 id 和类型默认继承
function blockFromPatch(raw, old, isNew) {
  const type = old.type === 'heading' ? 'heading' : VALID.has(raw.type) ? raw.type : old.type
  if (type === 'image' || type === 'divider') return null
  const id = isNew ? bid() : old.id
  if (type === 'heading') {
    const text = stripMark(raw.text)
    return text ? { id, type, level: old.level === 3 ? 3 : 2, text } : null
  }
  const section = SECTIONS.some((s) => s.id === raw.section)
    ? raw.section
    : SECTIONS.some((s) => s.id === old.section)
      ? old.section
      : 'core'
  const [nb] = normalizeBlocks([{ ...raw, type, section }])
  return nb ? { ...nb, id } : null
}

// 算出改动后的块数组，原笔记不动；改不动的写进 skipped 让模型/用户知道
export function planEdits(note, edits) {
  const blocks = (note.blocks || []).map((b) => ({ ...b }))
  const changed = []
  const skipped = []
  for (const raw of arr(edits)) {
    if (!raw || typeof raw !== 'object') continue
    const op = raw.op === 'insert' ? 'insert' : raw.op === 'remove' ? 'remove' : 'replace'
    const targetId = str(op === 'insert' ? raw.afterBlockId : raw.blockId)
    const at = blocks.findIndex((b) => b.id === targetId)
    if (at < 0) {
      skipped.push({ op, id: targetId, why: '这篇里没有这个块 id' })
      continue
    }
    const old = blocks[at]
    if (op === 'remove') {
      blocks.splice(at, 1)
      changed.push({ op, blockId: old.id, before: old, after: null, why: str(raw.why) })
      continue
    }
    const nb = blockFromPatch(raw, old, op === 'insert')
    if (!nb) {
      skipped.push({ op, id: targetId, why: '内容为空或这种块不支持自动改' })
      continue
    }
    if (op === 'insert') {
      blocks.splice(at + 1, 0, nb)
      changed.push({ op, blockId: nb.id, afterBlockId: old.id, before: null, after: nb, why: str(raw.why) })
      continue
    }
    const same = JSON.stringify(stripSection(old)) === JSON.stringify(stripSection(nb))
    if (same) {
      skipped.push({ op, id: targetId, why: '和原来一样，没改动' })
      continue
    }
    blocks[at] = nb
    changed.push({ op, blockId: old.id, before: old, after: nb, why: str(raw.why) })
  }
  return { blocks, changed, skipped }
}

// 只应用用户勾中的那几条改动：从原笔记重算，勾掉的块原样留着
export function applyChanges(note, changes) {
  const blocks = (note.blocks || []).map((b) => ({ ...b }))
  for (const c of changes || []) {
    if (c.op === 'remove') {
      const at = blocks.findIndex((b) => b.id === c.blockId)
      if (at >= 0) blocks.splice(at, 1)
    } else if (c.op === 'insert') {
      const at = blocks.findIndex((b) => b.id === c.afterBlockId)
      if (at >= 0) blocks.splice(at + 1, 0, { ...c.after })
    } else {
      const at = blocks.findIndex((b) => b.id === c.blockId)
      if (at >= 0) blocks[at] = { ...c.after }
    }
  }
  return blocks
}

/* ---------- L1：改一个块 ---------- */

export const AI_ACTIONS = [
  { id: 'polish', label: '润色', hint: '信息不变，更准更短', mode: 'replace' },
  { id: 'expand', label: '扩写', hint: '补推导、前提、对比', mode: 'replace' },
  { id: 'split', label: '拆成知识块', hint: '长段落拆成多张卡', mode: 'replace' },
  { id: 'qa', label: '造高频问法', hint: '生成面试官会问的题', mode: 'insert', target: '高频问法' },
  { id: 'pitfall', label: '造踩坑卡', hint: '生成易错点', mode: 'insert', target: '我踩过的坑' },
]

export const blockText = (b) =>
  [
    b.term,
    b.text,
    b.detail,
    b.latex,
    b.question,
    b.answer,
    b.cause,
    b.avoid,
    b.items ? b.items.join(' / ') : '',
    (b.rows || []).map((r) => `${r.k}: ${r.a} vs ${r.b}`).join(' / '),
  ]
    .filter(Boolean)
    .join(' | ')

// 让模型知道上下文：笔记标题 + 当前段落 + 同段落其他块
function noteContext(note, sectionTitle, block) {
  const lines = [`笔记标题：${note?.title || ''}`]
  if (sectionTitle) lines.push(`所在段落：${sectionTitle}`)
  const siblings = (note?.blocks || [])
    .filter((b) => b.id !== block.id && b.type !== 'heading')
    .slice(0, 12)
    .map((b) => `- [${b.type}] ${blockText(b).slice(0, 160)}`)
    .filter((s) => s.length > 12)
  if (siblings.length) lines.push(`同篇笔记其他块：\n${siblings.join('\n')}`)
  return lines.join('\n')
}

const ACTION_PROMPT = {
  polish:
    '保持信息量不变，改得更准确、更精炼，不要新增事实。用 rewrite_block 改写当前这一块。',
  expand:
    '把内容展开：补上推导过程、成立前提、与替代方案的对比。不要编造具体数字或论文名。内容一块装不下就拆：第一块 rewrite_block，后面的 add_block。',
  split:
    '把这段内容拆成多个知识点块，每个块只讲一件事。定义用 definition，公式用 formula，对比用 comparison，清单用 bulletList。第一块用 rewrite_block，其余用 add_block。',
  qa: '根据这个块的内容，生成 2-3 条面试官真会这么问的问题和你的答法，type 用 qa，section 用 qa，全部用 add_block 加在原块后面。答案要像人说话，不要「本概念是指」。',
  pitfall:
    '根据这个块的内容，生成 1-2 条真实容易踩的坑：现象 / 原因 / 怎么避免，type 用 pitfall，section 用 pitfall，全部用 add_block 加在原块后面。要具体，不要泛泛而谈。',
}

// 自由提问 / 自由要求：模型自己判断是「回答后补块」还是「直接改这一块」
const CUSTOM_SPEC = (ask) => `用户对这个块说的话：${ask}

按他这句话处理这个块：
- 如果是在提问（问机制、问区别、问「面试官追问怎么答」）：正面回答，再把回答整理成知识块用 add_block 加进去 —— 结论和机制用 paragraph，问法与答法用 qa，易错点用 pitfall，对比用 comparison。原块不动。
- 如果是在要求改写（写短点、加推导、换个说法、补对比）：用 rewrite_block 按他要求的范围重写原块。
- ${NO_FABRICATE_WRITE}`

// 单个块的改动一般三五步就说完，太长没必要；前两条（system + 开场上下文）常驻
const MAX_BLOCK_THREAD = 15

// 工具循环的安全阀：正常 2-4 轮就交差，绕圈说明 prompt 或模型跑偏了
const MAX_BLOCK_ROUNDS = 8

const blockSystem = (thinking, insertOnly) => `你在帮用户改一篇数据分析面试知识笔记里的一个块，是连续对话：用户会一轮轮提要求，你能看到自己前面几轮改出来的稿子，可以接着改、也可以只回答他的问题。你产出的内容最后会写进这篇笔记。
${BLOCK_SPEC}
${SECTION_SPEC}

怎么干：
- 稿子里的块都带 id。用工具一块一块改，每调一个工具程序就真改一处，并回你一句结果（改好了，还是 id 打错了），接着调下一个就行，没人催你。
- 全部改到位后调 finish_block 收尾，收尾之后不要再输出正文。要跟用户说的那句话放在 finish_block 的 say 里（≤60 字，像人说话，别复述字段名）。
- 只动这一块、以及能补在它旁边的块。别去改这篇笔记的别处 —— 那是整篇助手的活。
${insertOnly ? '- 这一轮是「在原块后面补内容」：原块一个字都不改，只用 add_block。\n' : ''}
工具：
- rewrite_block 改写稿子里的一块：换说法、换块类型、扩写、把两块并成一块都走它
- add_block    往稿子里加一块：拆出来的后半段、高频问法、踩坑卡、库外补充
- drop_block   从稿子里去掉一块：重复的、没用的、已经并进别块的
- finish_block 交差（只有它能结束这一轮）

规则：
- 用户可能已经跟你聊过几轮：稿子就是上一轮的成品。只做这一轮要求的微调，别把它改好的地方又改回去，也别重复做完的事。
- 不要输出 heading 块，段落由 section 字段决定。
- ${NO_FABRICATE_WRITE}${thinking ? '\n- 每一步只想这一个动作，别在思考里把整段稿子预演一遍 —— 后面的步骤等看到前一步的结果再想。' : ''}`

// 「现在这一块长什么样」：把块摊成一行给模型看，省 token
const blockLine = (b) => `[${b.type}] ${blockText(b)}`

// 稿子摆给模型看：带 id（工具要引用）、标出哪一块是原块
const draftOf = (plan) =>
  plan.length
    ? plan
        .map((e, i) => `${i + 1}. ${e.id}${e.root ? '（原块）' : ''} [${e.block.type}] ${blockText(e.block)}`)
        .join('\n')
    : '（现在稿子里没有块）'

/* ---------- 计划：模型每调一次工具就在这上面改一笔 ---------- */

const secOf = (b) => (SECTIONS.some((s) => s.id === b?.section) ? b.section : 'core')

// 首轮从原块起手；续聊从上一轮的成品起手（insert 模式下原块不在稿子里，所以没有 root 行）
const planOf = (live, block, prevMode) => {
  const hasRoot = prevMode !== 'insert'
  const list = arr(live).length ? arr(live) : hasRoot ? [{ ...block }] : []
  return list.map((b, i) => {
    const { id, section: _s, ...rest } = b
    return { id: str(id) || `blk-${i + 1}`, section: secOf(b), block: rest, root: hasRoot && i === 0, op: 'keep' }
  })
}

// 工具给的块内容过一遍 normalizeBlocks：未知类型 / 空内容会被洗干净或直接丢掉
const cleanBlock = (raw, section) => {
  const [b] = normalizeBlocks([{ ...(raw || {}), section }])
  if (!b) return null
  const { id: _id, section: sec, ...rest } = b
  return { section: sec, block: rest }
}

const reply = (content, summary = '') => ({ content, summary })

function blockTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'rewrite_block',
        description: '改写稿子里的一块：换说法、换块类型、扩写、把两块并成一块。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '块 id，原样引用稿子里给出来的那个' },
            section: { type: 'string', enum: SEC_IDS, description: '顺手换段才填，不填就留在原段' },
            block: BLOCK_ARG,
          },
          required: ['id', 'block'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_block',
        description: '往稿子里加一块：原块后面补内容、拆出来的后半段、高频问法、踩坑卡。',
        parameters: {
          type: 'object',
          properties: {
            block: BLOCK_ARG,
            section: { type: 'string', enum: SEC_IDS, description: '不填就跟着原块那一节' },
            after: AFTER_ARG,
          },
          required: ['block'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'drop_block',
        description: '从稿子里去掉一块：重复的、没用的、已经并进别块的。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish_block',
        description: '改完了就调这个交差，之后别再输出正文。',
        parameters: {
          type: 'object',
          properties: {
            say: { type: 'string', description: '一句中文，告诉用户这轮做了什么或答了什么（≤60 字）' },
          },
        },
      },
    },
  ]
}

function runBlockTool(ctx, name, raw) {
  const args = raw && typeof raw === 'object' ? raw : {}
  const plan = ctx.plan
  const id = str(args.id).trim()
  const at = plan.findIndex((e) => e.id === id)
  const ids = () => plan.map((e) => e.id).join('、') || '（现在稿子里没有块）'
  const noSuch = () => reply(`没有 id 为「${id}」的块，这一下没生效。现在稿子里的 id：${ids()}`, '⚠ 找不到块')

  if (name === 'finish_block') {
    ctx.say = stripMark(args.say) || ctx.say
    ctx.done = true
    return reply('收到，这一轮结束。', '✅ 交差')
  }

  if (name === 'rewrite_block') {
    // insert 那一路是「原块不动、只往后面加」：偷偷改原块会让用户看不出笔记被动了。
    // insert 的稿子里本来就没有原块，所以这种情况会落到「找不到 id」，要先说清原因
    if (at < 0 && ctx.insertOnly && id === str(ctx.block?.id))
      return reply(
        '这一轮只往原块后面加内容，原块一个字都不改。要加就用 add_block；要改原块文字，请用户单独点「润色」。',
        '⚠ 原块不动',
      )
    if (at < 0) return noSuch()
    const e = plan[at]
    if (e.root && ctx.insertOnly)
      return reply('这一轮是原块后面补内容，原块不动。要改原块文字请让用户单独点「润色」。', '⚠ 原块不动')
    const got = cleanBlock(args.block, secOk(args.section) || e.section)
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没写进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    e.block = got.block
    e.section = got.section
    e.op = 'replace'
    if (e.root) ctx.touched = true
    return reply(`已改写 ${e.id}。`, '✏ 改写一块')
  }

  if (name === 'add_block') {
    const got = cleanBlock(args.block, secOk(args.section) || secOf(ctx.block))
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没加进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    const e = { id: `pending-${++ctx.seq}`, section: got.section, block: got.block, root: false, op: 'add' }
    const after = str(args.after).trim()
    const i = after ? plan.findIndex((x) => x.id === after) : -1
    if (i < 0) plan.push(e)
    else plan.splice(i + 1, 0, e)
    return reply(
      `已加了 1 块，临时 id 是 ${e.id}（后面还要动它就用这个 id）。`,
      '➕ 新增一块',
    )
  }

  if (name === 'drop_block') {
    if (at < 0) return noSuch()
    const [e] = plan.splice(at, 1)
    if (e.root) ctx.touched = true
    return reply(e.root ? '原块已从这版稿子里去掉。' : `已删掉 ${e.id}。`, '🗑 删一块')
  }

  return reply(`没有叫 ${name} 的工具。`, '⚠ 工具不存在')
}

// 计划 → 要落进笔记的块。insert 模式下原块不跟着走（它本来就不该被替换）
const toBlocks = (ctx, mode) =>
  ctx.plan
    .filter((e) => !(e.root && e.op === 'keep' && mode === 'insert'))
    .map((e) => ({ id: e.root ? ctx.block.id : bid(), section: e.section, ...e.block }))

export async function rewriteBlock({
  action,
  ask = '',
  block,
  note,
  sectionTitle,
  cfg,
  messages,
  blocks,
  mode: prevMode = '',
  onStep,
  onNoThinking,
}) {
  if (!block) throw new Error('没有要改的块')
  const custom = String(ask || '').trim()
  const preset = AI_ACTIONS.find((a) => a.id === action)
  const spec = custom ? CUSTOM_SPEC(custom) : ACTION_PROMPT[action]
  if (!spec) throw new Error('未知的 AI 动作')

  const conf = cfg || loadAI()
  const hist = arr(messages)
  // 一段对话里做法要稳定：中途从 insert 跳到 replace 会把原块冲掉
  const insertOnly = prevMode === 'insert' || (!prevMode && preset?.mode === 'insert')
  const ctx = {
    plan: planOf(arr(blocks), block, prevMode),
    block,
    insertOnly,
    touched: false,
    say: '',
    done: false,
    seq: 0,
  }

  const ctxText = noteContext(note, sectionTitle, block)
  // 首轮：整篇上下文 + 原块 + 这次要干什么。续聊：原块和上下文已经在历史里了，只补「现在长什么样」
  const opener = `${ctxText}
当前块 ${block.id}（工具里要原样引用这个 id）：${blockLine(block)}

${spec}`
  const follow = `这一轮现在的稿子（是你前面几轮改出来的成品；块 id 以这里为准，以前的已经作废）：
${draftOf(ctx.plan)}
原块还是：${blockLine(block)}

这一轮要做的：${spec}`

  const thread = hist.length
    ? [...settleThread(hist), { role: 'user', content: follow }]
    : [
        { role: 'system', content: blockSystem(thinkOn(conf), insertOnly) },
        { role: 'user', content: opener },
      ]

  const tools = blockTools()
  let fellBack = false
  // 思考开关一旦降级、或某一轮没产出思考内容，后面就一路关着：没有 reasoning_content 的
  // assistant 消息在思考模式下再发会被 DeepSeek 直接 400 拒掉
  let think = thinkOn(conf)

  for (let round = 0; round < MAX_BLOCK_ROUNDS && !ctx.done; round++) {
    let res
    try {
      res = await chatStreamTools(thread, {
        cfg: think ? conf : { ...conf, thinking: 'off' },
        tools,
        temperature: custom ? 0.3 : 0.4,
        maxTokens: custom ? 2500 : 2000,
        onNoThinking: () => {
          fellBack = true
        },
      })
    } catch (e) {
      // 单块助手也是靠工具一块块改的，模型不认 tools 就干不了活：直接说清该换模型
      if (e.noTools)
        throw new Error('当前模型不支持工具调用（改块助手需要），到「设置」换成 deepseek-chat 这类通用模型再试')
      throw e
    }
    const { text, toolCalls, reasoning, thinking } = res
    // 它不调工具、直接说话了：把话留下（用户能接着追问），已经改好的照旧保留
    if (!toolCalls.length) {
      const said = str(text).trim()
      if (said) {
        if (!ctx.say) ctx.say = said
        const m = { role: 'assistant', content: said }
        if (thinking && reasoning) m.reasoning_content = reasoning
        if (!(thinking && reasoning)) think = false
        thread.push(m)
      }
      break
    }
    const said = {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: c.function })),
    }
    // DeepSeek 开思考又要带 tools 时，下一轮必须把这个字段原样回传，否则直接 400
    if (thinking && reasoning) said.reasoning_content = reasoning
    if (!(thinking && reasoning)) think = false
    thread.push(said)
    for (const c of toolCalls) {
      let args = {}
      try {
        args = JSON.parse(c.function.arguments || '{}')
      } catch {
        args = {}
      }
      const out = runBlockTool(ctx, c.function.name, args)
      if (onStep && out.summary) onStep(out.summary)
      thread.push({ role: 'tool', tool_call_id: c.id, content: out.content })
    }
  }

  // insert 还是 replace：一段对话里保持稳定。首轮按「点的是哪个按钮」定；自己说话那种，
  // 提问（只加块）默认补内容，动过原块才替换
  const mode =
    prevMode === 'insert' || prevMode === 'replace'
      ? prevMode
      : custom
        ? ctx.touched
          ? 'replace'
          : 'insert'
        : preset?.mode || 'replace'

  return {
    blocks: toBlocks(ctx, mode),
    mode,
    say: stripMark(ctx.say),
    noticed: fellBack,
    messages: trimThread(settleThread(thread), MAX_BLOCK_THREAD),
  }
}
