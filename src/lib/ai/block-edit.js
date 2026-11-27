// 改块：单个块的润色 / 扩写 / 拆块，以及按块 id 改写整篇里的若干块

import { chat, pickJson, trimThread } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, str, arr, bid, VALID, normalizeBlocks, stripSection, stripMark } from './schema.js'
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
  polish: '保持信息量不变，改得更准确、更精炼。不要新增事实。输出 1 个同类型或更合适的块。',
  expand: '把内容展开：补上推导过程、成立前提、与替代方案的对比。不要编造具体数字或论文名。输出 1-3 个块。',
  split:
    '把这段内容拆成多个知识点块，每个块只讲一件事。定义用 definition，公式用 formula，对比用 comparison，清单用 bulletList。输出 2-5 个块。',
  qa: '根据这个块的内容，生成 2-3 条面试官真会这么问的问题和你的答法，type 用 qa，section 用 qa。答案要像人说话，不要「本概念是指」。',
  pitfall:
    '根据这个块的内容，生成 1-2 条真实容易踩的坑：现象 / 原因 / 怎么避免，type 用 pitfall，section 用 pitfall。要具体，不要泛泛而谈。',
}

// 自由提问 / 自由要求：模型自己判断是「回答后补块」还是「直接改这一块」
const CUSTOM_SPEC = (ask) => `用户对这个块说的话：${ask}

按他这句话处理这个块：
- 如果是在提问（问机制、问区别、问「面试官追问怎么答」）：正面回答，再把回答整理成知识块 —— 结论和机制用 paragraph，问法与答法用 qa，易错点用 pitfall，对比用 comparison。这种情况原块不动，mode 用 insert。
- 如果是在要求改写（写短点、加推导、换个说法、补对比）：按他要求的范围重写原块，mode 用 replace。
- ${NO_FABRICATE_WRITE}`

// 单个块的改动一般三五轮就说完，太长没必要；前两条（system + 开场上下文）常驻
const MAX_BLOCK_THREAD = 15

const BLOCK_SYSTEM = `你在帮用户改一篇数据分析面试知识笔记里的一个块，是连续对话：用户会一轮轮提要求，你能看到自己前面几轮改出来的稿子，可以接着改、也可以只回答他的问题。你产出的内容最后会写进这篇笔记。
${BLOCK_SPEC}
${SECTION_SPEC}

每轮只输出一个 JSON 对象（不要代码块、不要多余的解释文字）：
{"say":"…","mode":"insert|replace","blocks":[{"type":"…","section":"…",…}]}
- say：用中文写给用户看的一句话，说清这轮做了什么或答了什么（≤60 字），像人说话，别复述 JSON、别提字段名。
- mode=replace 表示 blocks 替换掉原来这一块；mode=insert 表示原来这一块不动、blocks 插在它后面。`

// 「现在这一块长什么样」：把块摊成一行给模型看，省 token
const blockLine = (b) => `[${b.type}] ${blockText(b)}`

// 续聊时把上一轮的成品带上：用户要的可能只是「再短一点」，模型得知道在改什么
const draftOf = (blocks) =>
  JSON.stringify(arr(blocks).map(({ id, ...rest }) => rest), null, 1)

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
  onNoThinking,
}) {
  if (!block) throw new Error('没有要改的块')
  const custom = String(ask || '').trim()
  const preset = AI_ACTIONS.find((a) => a.id === action)
  const spec = custom ? CUSTOM_SPEC(custom) : ACTION_PROMPT[action]
  if (!spec) throw new Error('未知的 AI 动作')
  const hist = arr(messages)
  const live = arr(blocks).length ? arr(blocks) : [{ ...block }]
  const ctx = noteContext(note, sectionTitle, block)

  // 首轮：整篇上下文 + 原块 + 这次要干什么。续聊：原块和上下文已经在历史里了，只补「现在长什么样」
  const opener = `${ctx}
当前块：${blockLine(block)}

${spec}`
  const follow = `这一轮现在的稿子（是你前面几轮改出来的成品，${prevMode === 'insert' ? '插在原块后面、原块不动' : '用来替换原块'}）：
${draftOf(live)}
原块还是：${blockLine(block)}

这一轮要做的：${spec}`

  const thread = hist.length
    ? [...hist, { role: 'user', content: follow }]
    : [
        { role: 'system', content: BLOCK_SYSTEM },
        { role: 'user', content: opener },
      ]

  const text = await chat(thread, {
    cfg,
    temperature: custom ? 0.3 : 0.4,
    maxTokens: 2500,
    onNoThinking,
  })
  const data = pickJson(text)
  const out = normalizeBlocks(data.blocks)
  if (!out.length) throw new Error('模型没给出可用内容，换个说法再试')
  // insert 还是 replace 在一段对话里保持稳定：中途换掉会把原块冲掉。
  // 首轮按「点的是哪个按钮」定；自己说话那种，提问默认补内容，模型明确说要改才替换
  const mode =
    prevMode === 'insert' || prevMode === 'replace'
      ? prevMode
      : custom
        ? data.mode === 'replace'
          ? 'replace'
          : 'insert'
        : preset?.mode || 'replace'

  return {
    blocks: out,
    mode,
    say: stripMark(data.say),
    messages: trimThread([...thread, { role: 'assistant', content: text }], MAX_BLOCK_THREAD),
  }
}
