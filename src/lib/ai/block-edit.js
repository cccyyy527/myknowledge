// 改块：单个块的润色 / 扩写 / 拆块，以及按块 id 改写整篇里的若干块

import { chatStreamTools, loadAI, thinkOn, trimThread, settleThread } from './client.js'
import {
  SECTIONS,
  str,
  arr,
  bid,
  VALID,
  normalizeBlocks,
  stripSection,
  stripMark,
  SEC_IDS,
  secOk,
  secTitle,
  BLOCK_ARG,
  AFTER_ARG,
} from './schema.js'
import { NO_FABRICATE_WRITE } from './prompts.js'
import { systemFor } from './skills/index.js'

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

// 段落以 heading 为界（和 entriesOf / revise.js 同一套判法）；标题被手动改过就按第几个 heading 兜底
function secRanges(blocks) {
  const heads = []
  blocks.forEach((b, i) => {
    if (b.type === 'heading' && (b.level || 2) === 2) heads.push({ at: i, text: str(b.text) })
  })
  return heads.map((h, nth) => ({
    id: SEC_IDS.find((x) => secTitle(x) === h.text) || SEC_IDS[Math.min(nth, SEC_IDS.length - 1)],
    start: h.at,
    end: heads[nth + 1] ? heads[nth + 1].at : blocks.length,
  }))
}

const sectionAt = (blocks, index) => {
  const hit = secRanges(blocks).find((r) => index >= r.start && index < r.end)
  return hit ? hit.id : ''
}

// 归位：把一块挪到目标段落末尾。笔记是按 heading 顺序渲染的，只改 section 字段不算挪，
// 必须把块在数组里真的搬过去
function relocate(blocks, blockId, section) {
  const at = blocks.findIndex((b) => b.id === blockId)
  if (at < 0) return null
  const old = blocks[at]
  const moved = { ...old, section }
  blocks.splice(at, 1)
  const range = secRanges(blocks).find((r) => r.id === section)
  if (!range) blocks.push({ id: bid(), type: 'heading', level: 2, text: secTitle(section) }, moved)
  else blocks.splice(range.end, 0, moved)
  return { old, moved }
}

// 算出改动后的块数组，原笔记不动；改不动的写进 skipped 让模型/用户知道
export function planEdits(note, edits) {
  const blocks = (note.blocks || []).map((b) => ({ ...b }))
  const changed = []
  const skipped = []
  for (const raw of arr(edits)) {
    if (!raw || typeof raw !== 'object') continue
    const op = ['insert', 'remove', 'move'].includes(raw.op) ? raw.op : 'replace'
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
    // 只换段落：内容一个字不动，把整块搬到目标段
    if (op === 'move') {
      const to = secOk(raw.section)
      if (!to) {
        skipped.push({ op, id: targetId, why: 'move 要说清挪到哪一节（section 必填）' })
        continue
      }
      if (sectionAt(blocks, at) === to) {
        skipped.push({ op, id: targetId, why: `本来就在「${secTitle(to)}」` })
        continue
      }
      const { old: before, moved } = relocate(blocks, targetId, to)
      changed.push({ op: 'move', blockId: before.id, before, after: moved, why: str(raw.why) })
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
      // 内容没变、只有 section 变了：模型想表达的就是「归位」，别当成没改动丢掉
      if (nb.section !== old.section) {
        const { old: before, moved } = relocate(blocks, targetId, nb.section)
        changed.push({ op: 'move', blockId: before.id, before, after: moved, why: str(raw.why) })
      } else skipped.push({ op, id: targetId, why: '和原来一样，没改动' })
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
    } else if (c.op === 'move') {
      const to = c.after?.section
      if (to) relocate(blocks, c.blockId, to)
    } else {
      const at = blocks.findIndex((b) => b.id === c.blockId)
      if (at >= 0) blocks[at] = { ...c.after }
    }
  }
  return blocks
}

/* ---------- 追加之前先去重：这篇已有的块该归位 / 该改写，不该再抄一份 ---------- */

// 只留文字和数字，标点空白全去掉：同一句话换个标点不算新内容
const plainText = (v) => str(v).replace(/[\s\u3000\u00b7:：,，。、/|()（）[\]【】<>《》\-——"'“”‘’!！?？;；]/g, '')

export const flatOf = (b) =>
  plainText(
    [
      b.text,
      b.term,
      b.question,
      b.answer,
      b.latex,
      b.detail,
      b.cause,
      b.avoid,
      (b.items || []).join(''),
      (b.rows || []).map((r) => `${r.k}${r.a}${r.b}`).join(''),
    ]
      .filter(Boolean)
      .join(''),
  )

const bigrams = (s) => {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

// 同一段话说两遍：短块要求一字不差，长块容许措辞差别。
// 八字以下不比相似度，免得「方差」和「方差缩减」被当成同一句
const SIM_SURE = 0.8 // 字面几乎一样：直接认定重复，不用问模型
// 预筛只负责「值得让模型看一眼」，所以压得低：实测同义改写（缩尾 / 截断）字面只有 .38～.5，
// 门槛放在 .6 以上等于自己先把要判的那种情况筛掉了。真正的判断交给 reviewWrite 的模型
const SIM_NEAR = 0.3

// 短串被长串覆盖的比例
function coverOf(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 6) return 0
  const A = bigrams(short)
  const B = bigrams(long)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / A.size
}

// Dice 系数：只看覆盖率时，新块比老块多写一倍内容就会被判成「不重复」，
// 同义改写基本漏检；两个口径取大值，短块不容易误判、长块也不至于漏
function diceOf(a, b) {
  if (!a || !b) return 0
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 6) return 0
  const A = bigrams(short)
  const B = bigrams(long)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return (2 * hit) / (A.size + B.size)
}

const numbersOf = (s) => new Set(s.match(/\d+(?:\.\d+)?/g) || [])

// 0～1 的相似度。数字重合是最强的信号：同一个口径、同一组阈值、同一批数，
// 十有八九是在讲同一件事，只是换了说法
export function pairScore(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const sim = Math.max(coverOf(a, b), diceOf(a, b))
  if (sim < 0.35) return sim
  const A = numbersOf(a)
  const B = numbersOf(b)
  let shared = 0
  for (const n of A) if (B.has(n) && n.length >= 2) shared++
  // 封在 0.79：数字重合只用来「拉进候选」，绝不靠它直接判成重复
  return shared >= 2 ? Math.min(0.79, sim + 0.15) : sim
}

export function alikeBody(a, b) {
  return coverOf(a, b) >= SIM_SURE
}


const sectionOfId = (blocks, id) => {
  const at = blocks.findIndex((b) => b.id === id)
  return at < 0 ? '' : sectionAt(blocks, at)
}

const labelOf = (b) => {
  const raw = str(b.text || b.term || b.question || b.answer || b.latex || (b.items || [])[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.length > 18 ? `${raw.slice(0, 18)}…` : raw
}

// 这次要加的块里，哪些和这篇已有的块（或本次已收的块）沾边。
// 返回带 sim 的候选：sim ≥ 0.8 当场算重复，0.34～0.8 之间交给语义复核判。
// 同一批里的块也要互相比：模型很容易在一条回答里把同一件事拆成两块写两遍，
// 而这种情况旧块里可能一个字都没有，只比旧块会整个漏掉
export function dupCandidates(note, blocks, skipIds = []) {
  const pool = (note?.blocks || [])
    .filter((b) => b.type !== 'heading' && !skipIds.includes(b.id))
    .map((b) => ({ b, t: flatOf(b) }))
    .filter((x) => x.t)
  const seen = []
  const hits = []
  arr(blocks).forEach((block, i) => {
    const t = flatOf(block)
    if (!t) return
    let best = null
    for (const [list, batch] of [
      [pool, false],
      [seen, true],
    ]) {
      for (const e of list) {
        const sim = pairScore(t, e.t)
        if (sim >= SIM_NEAR && (!best || sim > best.sim)) best = { sim, block: e.b, batch }
      }
    }
    if (best) {
      hits.push({
        i,
        block,
        old: best.block,
        sameBatch: best.batch,
        section: best.batch ? '' : sectionOfId(note.blocks, best.block.id),
        sim: best.sim,
      })
    }
    seen.push({ b: block, t })
  })
  return hits
}

// 这次要加的块里，哪些和这篇已有的块讲的是同一件事（字面层面已经确定的那种）
export function dupBlocks(note, blocks, skipIds = []) {
  return dupCandidates(note, blocks, skipIds).filter((x) => x.sim >= SIM_SURE)
}


export function dupIssue(hits) {
  const batch = hits.filter((h) => h.sameBatch)
  const rows = hits
    .filter((h) => !h.sameBatch)
    .map(({ block, old, section }) => {
      const where = section ? `「${secTitle(section)}」` : '这篇'
      const was = labelOf(old)
      return `- 想加的「${labelOf(block)}」＝ ${where}里的 [#${old.id}]${was ? `「${was}」` : ''}`
    })
  if (batch.length) {
    rows.push(
      `- 这次要加的里面自相重复：第 ${batch.map((h) => h.i + 1).join('、')} 块和第 ${batch[0].i + 1} 块讲的是同一件事，只留一块`
    )
  }
  return `这篇已经有这些内容了，再加就是同一段话说两遍：\n${rows.join('\n')}\n改成 mode=edit，把动作落在已有那块上：段落放错了就用 op=move（blockId 填 [#] 里的 id、section 填该去的那段，内容不用重给）；说法过时或要补一句就用 op=replace（blockId 同上，给全改完的整块内容）。这篇确实没写过的内容才用 mode=exist 追加。`
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

// 首轮上下文：笔记标题 + 所在段落。别的块不用在这儿列，整篇稿子在下面
function noteContext(note, sectionTitle) {
  const lines = [`笔记标题：${note?.title || ''}`]
  if (sectionTitle) lines.push(`所在段落：${sectionTitle}`)
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

// 自由提问 / 自由要求：模型自己判断是「回答问题后补块」还是「改块」，也能被指到别处去
const CUSTOM_SPEC = (ask) => `用户对这一块（原块）说的话：${ask}

按他这句话处理：
- 在提问（问机制、问区别、问「面试官追问怎么答」）：正面回答，再把回答整理成知识块用 add_block 加进去 —— 结论和机制用 paragraph，问法与答法用 qa，易错点用 pitfall，对比用 comparison。原块不动。
- 在要求改写（写短点、加推导、换个说法、补对比）：用 rewrite_block 按他要求的范围重写原块。
- 说的是别处（「顺带把上面那块也改掉」「把重复的那块删了」「这块应该挪到推导段」）：照做，用稿子里的 id 定位，跨段也行。
- ${NO_FABRICATE_WRITE}`

// 单个块的改动一般三五步就说完；跨块改会多一些，留一点余量
const MAX_BLOCK_THREAD = 15

// 工具循环的安全阀：正常 2-4 轮就交差，绕圈说明 prompt 或模型跑偏了
const MAX_BLOCK_ROUNDS = 12

// thinking / insertOnly 是这一轮的开关，不是每轮都守的规矩，所以从 append 拼进去；正文在 skills/block.md
const blockSystem = (thinking, insertOnly) =>
  systemFor('block', {
    append: [
      insertOnly && '- 这一轮是「在原块后面补内容」：原块一个字都不改，只用 add_block。',
      thinking && '- 每一步只想这一个动作，别在思考里把整段稿子预演一遍 —— 后面的步骤等看到前一步的结果再想。',
    ]
      .filter(Boolean)
      .join('\n'),
  })

// 「现在这一块长什么样」：把块摊成一行给模型看，省 token
const blockLine = (b) => `[${b.type}] ${blockText(b)}`

// 稿子摆给模型看：整篇按顺序，带 id（工具要引用）、标出哪一块是原块。
// 整篇塞进来会把 prompt 撑大，所以每块只给开头一段；真要全文的那块另有 blockLine
const brief = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

const draftOf = (entries) =>
  entries.length
    ? entries
        .map((e, i) =>
          e.head
            ? `## ${e.block.text}`
            : `${i + 1}. ${e.id}${e.root ? '（原块）' : ''} [${e.block.type}] ${brief(blockText(e.block))}`,
        )
        .join('\n')
    : '（现在稿子里没有块）'

/* ---------- 稿子：模型每调一次工具就在这上面改一笔 ---------- */

const bodyOf = (b) => {
  const { id: _id, section: _s, ...rest } = b || {}
  return rest
}

const secIdOfTitle = (t) => (SECTIONS.find((s) => s.title === str(t)) || {}).id || ''

// 段落归属靠 heading 的位置算（块本身不存 section 字段）；上一轮挪过段的块，位置已经在目标段里
const entriesOf = (list) => {
  let sec = SECTIONS[0].id
  let title = SECTIONS[0].title
  return arr(list).map((b) => {
    if (b?.type === 'heading' && b.level === 2) {
      sec = secIdOfTitle(b.text)
      title = str(b.text)
      return { id: str(b.id), section: sec, title, head: true, block: bodyOf(b) }
    }
    return { id: str(b.id), section: sec, title, block: bodyOf(b) }
  })
}

// 稿子 vs 原笔记：按 id 算改动。跨段挪动拆成「删掉 + 按新位置插回」，落库时不用另照顾
const opsOf = (entries, note, rootId) => {
  const old = entriesOf(note?.blocks)
  const oldById = new Map(old.map((e) => [e.id, e]))
  const live = new Set(entries.map((e) => e.id))
  const ops = []
  for (const e of old) if (!live.has(e.id)) ops.push({ op: 'drop', id: e.id, title: e.title, before: e.block })
  let prev = ''
  for (const e of entries) {
    const o = oldById.get(e.id)
    if (!o) ops.push({ op: 'add', id: e.id, after: prev, title: e.title, block: e.block })
    else if (!e.head && o.section !== e.section) {
      ops.push({ op: 'drop', id: e.id, title: o.title, before: o.block })
      ops.push({ op: 'add', id: e.id, after: prev, title: e.title, block: e.block })
    } else if (JSON.stringify(o.block) !== JSON.stringify(e.block))
      ops.push({ op: 'replace', id: e.id, title: e.title, block: e.block })
    prev = e.id
  }
  return ops.map((o) => (o.id === rootId ? { ...o, root: true } : o))
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
            section: { type: 'string', enum: SEC_IDS, description: '要把这块挪到别段才填，不填就留在原段' },
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
            section: { type: 'string', enum: SEC_IDS, description: '加到哪一节；不填就跟 after 那块同一节，再不然跟原块同一节' },
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
  const plan = ctx.entries
  const id = str(args.id).trim()
  const at = plan.findIndex((e) => e.id === id)
  const ids = () =>
    plan.filter((e) => !e.head).map((e) => e.id).join('、') || '（现在稿子里没有块）'
  const noSuch = () =>
    reply(`没有 id 为「${id}」的块，这一下没生效。稿子里的 id：${ids()}（段落标题不用 id）`, '⚠ 找不到块')
  const noHead = () =>
    reply('段落标题是程序按段落生成的，改不了也删不了；要调位置就改 add_block 的 after。', '⚠ 标题块不动')

  if (name === 'finish_block') {
    ctx.say = stripMark(args.say) || ctx.say
    ctx.done = true
    return reply('收到，这一轮结束。', '✅ 交差')
  }

  if (name === 'rewrite_block') {
    // insert 那一路是「原块不动、只往后面加」：偷偷改原块会让用户看不出笔记被动了
    if (id === str(ctx.block.id) && ctx.insertOnly)
      return reply(
        '这一轮只往原块后面加内容，原块一个字都不改。要加就用 add_block；要改原块文字，请用户单独点「润色」。',
        '⚠ 原块不动',
      )
    if (at < 0) return noSuch()
    const e = plan[at]
    if (e.head) return noHead()
    const sec = secOk(args.section)
    const got = cleanBlock(args.block, sec || e.section)
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没写进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    e.block = got.block
    const moved = !!sec && sec !== e.section
    if (moved) {
      // 真把这块挪到目标段的末尾：光改 section 字段没用，位置不动等于没挪
      e.section = got.section
      e.title = secTitle(got.section)
      plan.splice(at, 1)
      let end = -1
      plan.forEach((x, i) => {
        if (x.section === e.section) end = i
      })
      plan.splice(end >= 0 ? end + 1 : plan.length, 0, e)
    }
    if (e.id === str(ctx.block.id)) ctx.touched = true
    return reply(
      `已改写 ${e.id}${moved ? `（挪到「${e.title}」）` : ''}。`,
      moved ? '✏ 改写并挪段' : '✏ 改写一块',
    )
  }

  if (name === 'add_block') {
    const after = str(args.after).trim()
    const anchor = after
      ? plan.findIndex((x) => x.id === after)
      : plan.findIndex((x) => x.id === str(ctx.block.id))
    // after 给了却对不上，别默默塞到文末 —— 位置错了用户很难发现
    if (after && anchor < 0)
      return reply(
        `没有 id 为「${after}」的块，这块没加。稿子里的 id：${ids()}；不想指定位置就省略 after。`,
        '⚠ 找不到 after',
      )
    const host = anchor >= 0 ? plan[anchor] : null
    const sec = secOk(args.section) || host?.section || SECTIONS[0].id
    const got = cleanBlock(args.block, sec)
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没加进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    const e = { id: bid(), section: got.section, title: secTitle(got.section), block: got.block }
    // 位置要跟着 section 走：说加到「高频问法」，就不能插在核心结论那块后面
    let at2 = anchor + 1
    if (got.section !== host?.section) {
      let end = -1
      plan.forEach((x, i) => {
        if (x.section === got.section) end = i
      })
      at2 = end >= 0 ? end + 1 : plan.length
    }
    if (at2 > 0) plan.splice(at2, 0, e)
    else plan.push(e)
    return reply(`已加了 1 块，id 是 ${e.id}（后面还要动它就用这个 id）。`, '➕ 新增一块')
  }

  if (name === 'drop_block') {
    if (at < 0) return noSuch()
    const e = plan[at]
    if (e.head) return noHead()
    plan.splice(at, 1)
    if (e.id === str(ctx.block.id)) ctx.touched = true
    return reply(e.id === str(ctx.block.id) ? '原块已从这版稿子里去掉。' : `已删掉 ${e.id}。`, '🗑 删一块')
  }

  return reply(`没有叫 ${name} 的工具。`, '⚠ 工具不存在')
}

// 稿子 → 原笔记形状的块数组：下一轮接着用（段落归属由 heading 位置再算一遍）
const toBlocks = (entries) => entries.map((e) => ({ id: e.id, ...e.block }))

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
  const rootId = str(block.id)
  // 稿子 = 整篇笔记。续聊时用上一轮交回来的成品（还没落库的那一版），否则用笔记现在的样子
  const entries = entriesOf(arr(blocks).length ? arr(blocks) : note?.blocks)
  entries.forEach((e) => {
    if (e.id === rootId) e.root = true
  })
  const ctx = { entries, block, insertOnly, touched: false, say: '', done: false }

  const ctxText = noteContext(note, sectionTitle)
  // 首轮：整篇稿子 + 原块 + 这次要干什么。续聊：稿子已经换过几版，重给现在这一版
  const opener = `${ctxText}
稿子（整篇笔记现在的内容，块 id 以这里为准）：
${draftOf(entries)}
原块是标了（原块）的那一块 ${rootId}：${blockLine(block)}

${spec}`
  const follow = `这一轮现在的稿子（是你前面几轮改出来的成品；块 id 以这里为准，以前的已经作废）：
${draftOf(ctx.entries)}

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
    ops: opsOf(ctx.entries, note, rootId),
    // 下一轮续聊要用的成品稿（还没落库的那一版），段落归属每轮按 heading 位置重算
    blocks: toBlocks(ctx.entries),
    mode,
    say: stripMark(ctx.say),
    noticed: fellBack,
    messages: trimThread(settleThread(thread), MAX_BLOCK_THREAD),
  }
}
