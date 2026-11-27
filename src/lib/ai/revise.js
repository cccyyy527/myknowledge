// 整篇改写：先算一份结构诊断，模型只输出操作列表，落库前再按块 id 校验一遍

import { newBlockId, liveNoteById } from '../store.js'
import { searchNotes, blockText } from '../retrieve.js'
import { chatStreamTools, loadAI, thinkOn } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, VALID, str, arr, normalizeBlocks, assembleBlocks, stripMark } from './schema.js'
import { NO_FABRICATE_WRITE } from './prompts.js'
import { topicCatalog, topicExists, fallbackTopicId } from './topics.js'

/* ---------- 段落归属 ---------- */

const TYPE_NAME = {
  paragraph: '段落',
  definition: '概念卡',
  formula: '公式',
  comparison: '对比',
  qa: '问答',
  pitfall: '坑',
  steps: '步骤',
  callout: '提示',
  bulletList: '列表',
  code: '代码',
  todo: '占位',
}

const squash = (v) => str(v).replace(/[\s\u3000·:：,，、/|()（）[\]【】<>《》\-—_]+/g, '')

// 标题 → 段 id：先精确、再互相包含（用户把「推导 / 细节」改成「推导」也能认出来）
const sectionByTitle = (text) => {
  const t = squash(text)
  if (!t) return ''
  const hit = SECTIONS.find((s) => squash(s.title) === t)
  if (hit) return hit.id
  const loose = SECTIONS.find((s) => squash(s.title).includes(t) || t.includes(squash(s.title)))
  return loose ? loose.id : ''
}

// 块属于哪一段：以 heading 为界；标题被手动改过就按第几个 heading 落位，别整篇错段
export function sectioned(note) {
  const out = []
  let cur = SECTIONS[0].id
  let nth = 0
  for (const b of note?.blocks || []) {
    if (b.type === 'heading' && (b.level || 2) === 2) {
      cur = sectionByTitle(b.text) || SECTIONS[Math.min(nth, SECTIONS.length - 1)].id
      nth++
      continue
    }
    out.push({ section: cur, block: b })
  }
  return out
}

const sectionsOf = (note) => new Map(sectioned(note).map((r) => [r.block.id, r.section]))

const blockKey = (b) =>
  squash(b.text || b.term || b.question || b.answer || b.latex || (b.items || [])[0] || '')

/* ---------- 结构诊断：模型自己看不出笔记哪里歪了，程序先算给它 ---------- */

export function diagnose(note) {
  const rows = sectioned(note)
  const total = rows.length
  const sections = SECTIONS.map((s) => {
    const items = rows.filter((r) => r.section === s.id).map((r) => r.block)
    const types = {}
    for (const b of items) types[b.type] = (types[b.type] || 0) + 1
    return { id: s.id, title: s.title, count: items.length, types }
  })

  const flags = []
  const empty = sections.filter((s) => !s.count).map((s) => s.title)
  if (empty.length) flags.push(`空段：${empty.join('、')} —— 一个字都没有`)

  const qa = sections.find((s) => s.id === 'qa')
  if (qa && !qa.count) flags.push('一个问答卡都没有 —— 这篇还不能直接拿来练面试')
  const pf = sections.find((s) => s.id === 'pitfall')
  if (pf && !pf.count) flags.push('没有坑卡 —— 没写自己真踩过什么')

  const contiguous = (types) => {
    const hits = []
    let run = 1
    for (let i = 1; i <= types.length; i++) {
      if (i < types.length && types[i] === types[i - 1]) {
        run++
        continue
      }
      if (run >= 3) hits.push({ type: types[i - 1], n: run })
      run = 1
    }
    return hits
  }
  for (const s of sections) {
    const items = rows.filter((r) => r.section === s.id).map((r) => r.block.type)
    for (const h of contiguous(items))
      flags.push(`${s.title} 里连着 ${h.n} 个${TYPE_NAME[h.type] || h.type} —— 多半该合并成一张卡，或者拆进别的段`)
  }

  const seen = new Map()
  const dupes = []
  for (const r of rows) {
    const k = blockKey(r.block).slice(0, 24)
    if (!k) continue
    if (seen.has(k)) dupes.push({ a: seen.get(k).id, b: r.block.id, why: k.slice(0, 16) })
    else seen.set(k, r.block)
  }
  if (dupes.length) flags.push(`${dupes.length} 组块开头一模一样 —— 可能是重复块`)

  const long = rows.filter((r) => {
    const t = str(r.block.text || r.block.answer)
    return t.length > 320 && !t.includes('\n')
  })
  if (long.length) flags.push(`${long.length} 块超过 320 字还是一次写到尾 —— 该拆成几块`)

  for (const s of sections) {
    if (!s.count) continue
    if (s.id === 'qa' && s.types.qa !== s.count)
      flags.push(`「高频问法」里有 ${s.count - (s.types.qa || 0)} 块不是问答卡 —— 大概放错段了`)
    if (s.id === 'pitfall' && s.types.pitfall !== s.count)
      flags.push(`「我踩过的坑」里有 ${s.count - (s.types.pitfall || 0)} 块不是坑卡 —— 大概放错段了`)
  }

  const text = [
    `全篇 ${total} 块。分段：`,
    ...sections.map(
      (s) =>
        `- ${s.title}（${s.id}）：${s.count} 块` +
        (s.count
          ? '，' + Object.entries(s.types).map(([t, n]) => `${TYPE_NAME[t] || t}×${n}`).join(' ')
          : ''),
    ),
    flags.length ? `\n结构问题：\n${flags.map((f) => '- ' + f).join('\n')}` : '\n结构上没看出明显问题。',
  ].join('\n')

  return { total, sections, flags, dupes, text }
}

/* ---------- 让模型出改动 ---------- */

// 改一篇时不该闭着眼：把库里相邻的几篇摘要塞进 prompt，模型才知道哪句该指过去、哪句跟别人说法打架
export function relatedNotes(note, { limit = 5 } = {}) {
  if (!note) return []
  const heads = (note.blocks || [])
    .filter((b) => b.type === 'heading' && b.level === 2)
    .map((b) => str(b.text))
  const probe = [note.title, ...(note.tags || []), ...heads].filter(Boolean).join(' ')
  const extra = (note.blocks || [])
    .filter((b) => b.type !== 'heading')
    .slice(0, 8)
    .map((b) => blockText(b))
    .join(' ')
  if (!probe.trim()) return []
  return searchNotes(probe, { limit: limit + 4, extra })
    .filter((x) => x.id !== note.id)
    .slice(0, limit)
    .map((x) => {
      const full = liveNoteById(x.id)
      const bits = (full?.blocks || [])
        .filter((b) => b.type !== 'heading')
        .map((b) => blockText(b).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const text = bits
        .slice(0, 4)
        .map((t) => (t.length > 110 ? `${t.slice(0, 110)}…` : t))
        .join(' / ')
      return { id: x.id, title: x.title, path: x.path, text }
    })
}

// 多轮：把前几轮的指令带给模型，免得它把已经改好的地方又改回去
const roundsText = (history) => {
  const list = arr(history)
    .map((x) => str(x).trim())
    .filter(Boolean)
    .slice(-4)
  if (!list.length) return ''
  return `\n前几轮已经改过这些（下面的块就是改完的样子，别重复做，也别撤销）：\n${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
}

const reviseSystem = (allowSplit, outside, thinking) => `你在改一篇数据分析面试知识笔记，一次只动一块，改完交差。用户会给你现有内容、程序算出的结构诊断、以及想要的改动。

${BLOCK_SPEC}
${SECTION_SPEC}

怎么干：
- 现有块都带 id。用工具一块一块改：挪、改写、删、补。每调一个工具，程序就真改一处，并回你一句结果（成功，还是 id 打错了），接着调下一个就行，没人催你。
- 块多就多调几次，别想着一次说完。全部改到位后调 finish_revision 收尾，收尾之后不要再输出正文。

能做的事（不只是改错字）：
- move_block     把块挪到别的段（结构问题多半是块放错了段），同段内也能用来调先后
- rewrite_block  原地改写一块（两块要合并：把内容并进一块，再 drop 掉多余那块；要拆分：改写前半段，后半段 add_block）
- add_block      新增一块（补空段、放拆出来的后半段、补库外知识）
- drop_block     删掉一块（重复的、没用的、已经并进别块的）
${allowSplit ? '- split_note     这篇装了两件不相关的事，把次要那几块挪去单独一篇（原篇不再留它们）\n' : ''}- finish_revision 交差（只有它能结束这一轮）

规则：
- 先读结构诊断再动手。诊断点出来的空段、连续同类型、重复块、放错段，都可以直接处理。
- 用户可能已经跟你改过几轮：现有块就是上一轮的成品。只做这一轮要求的微调，别把它改好的地方又改回去，也别重复做完的事。
- 但只挪位置的块（move_block）文字必须一字不改 —— 不许顺手润色、不许改措辞。文字要动就走 rewrite_block，让用户在面板上看得出这块钱变了。
- 允许重排、允许合并同类块、允许把过长的块拆成几块。
- 库里相邻的笔记只给了摘要，用来做两件事：① 那边已经写透的结论，这篇别再造一遍，确实相关就在块里用 [[笔记完整标题]] 指过去（标题一字不差，写错就跳不过去）；② 这篇跟相邻笔记说法不一致时，不要自己挑一个，写进 finish_revision 的 advice 留给用户判断。
- ${NO_FABRICATE_WRITE}
${outside ? `- 用户允许你用笔记之外的知识补内容。笔记里没写清楚、或者明显缺的那一块，可以直接写进去，但要写成能站住的结论：写清成立条件、适用范围，别只丢一句结论。
- 这类库外内容调工具时带 outside:true，用户能在面板上逐条看到哪些是新知识、再决定要不要。只在 add_block / rewrite_block 上标。
- 库外内容也要守上面的规矩：不要编具体数字、论文名、公司案例；拿不准的就用 todo 块占位，别硬写。
` : ''}- 不要输出 heading 块，段落由 section 字段决定。
- finish_revision 的 title 只在指令明确要求改标题时才给，否则省略。
- finish_revision 的 advice 只有一句话：跨笔记那部分值得用户注意的事（该指过去的、说法冲突的）。没有就省略。${thinking ? '\n- 每一步只想这一个动作，别在思考里把整篇稿子预演一遍 —— 后面的步骤等看到前一步的结果再想。' : ''}${allowSplit ? '\n- split_note 要克制：只有「这篇真正在讲两件事、拆开后各自更完整」才用。为了看起来整齐而拆细，只会让库更碎。' : ''}`

/* ---------- 工具：一次只让模型动一块 ---------- */

// 轮数给足：一篇笔记动十来处很正常；给不够它就会半途收工
const MAX_REVISE_ROUNDS = 24

const SEC_IDS = SECTIONS.map((s) => s.id)
const secTitle = (id) => (SECTIONS.find((s) => s.id === id) || SECTIONS[0]).title
const secOk = (v) => (SEC_IDS.includes(str(v)) ? str(v) : '')

// 与 BLOCK_SPEC 一一对应：这里只列字段名，怎么填靠 system 里那段说明
const BLOCK_ARG = {
  type: 'object',
  description: '改完的块内容：type 必填，其余字段按块类型规范给',
  properties: {
    type: { type: 'string', enum: [...VALID] },
    text: { type: 'string' },
    term: { type: 'string' },
    detail: { type: 'string' },
    latex: { type: 'string' },
    left: { type: 'string' },
    right: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { k: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
      },
    },
    question: { type: 'string' },
    answer: { type: 'string' },
    cause: { type: 'string' },
    avoid: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    tone: { type: 'string', enum: ['tip', 'warn'] },
  },
  required: ['type'],
}

const AFTER_ARG = { type: 'string', description: '插到哪一块后面（块 id）；省略就排在该小节末尾' }
const OUTSIDE_ARG = { type: 'boolean', description: '这块用了笔记之外的知识才填 true' }

function reviseTools(allowSplit) {
  const list = [
    {
      type: 'function',
      function: {
        name: 'move_block',
        description: '把一块挪到别的小节，或调同小节内的先后顺序。只换位置，不改文字。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '块 id，原样引用给出来的那个' },
            section: { type: 'string', enum: SEC_IDS },
            after: AFTER_ARG,
          },
          required: ['id', 'section'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rewrite_block',
        description:
          '原地改写一块：换说法、换块类型、合并两块（把要并的内容都写进这一块，再去掉多余那块）。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            section: { type: 'string', enum: SEC_IDS, description: '顺手换段才填，不填就留在原段' },
            block: BLOCK_ARG,
            outside: OUTSIDE_ARG,
          },
          required: ['id', 'block'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_block',
        description: '新增一块：补空掉的小节、放拆分出来的后半段、补库外知识。',
        parameters: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: SEC_IDS },
            block: BLOCK_ARG,
            after: AFTER_ARG,
            outside: OUTSIDE_ARG,
          },
          required: ['section', 'block'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'drop_block',
        description: '删掉一块：重复的、没用的、已经合并进别块的。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
  ]
  if (allowSplit)
    list.push({
      type: 'function',
      function: {
        name: 'split_note',
        description: '这篇在讲两件事，把次要的那几块挪去单独一篇。',
        parameters: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            title: { type: 'string', description: '新篇标题' },
            topicId: { type: 'string', description: '从给出的分类树里原样复制' },
            why: { type: 'string', description: '为什么拆出去' },
          },
          required: ['ids', 'title'],
        },
      },
    })
  list.push({
    type: 'function',
    function: {
      name: 'finish_revision',
      description: '改完了就调这个交差，之后别再输出正文。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '只有用户明确要求改标题才填' },
          advice: { type: 'string', description: '一句话：跨笔记值得用户注意的事，没有就省略' },
        },
      },
    },
  })
  return list
}

// 现有笔记 → 一份「计划」：模型每调一次工具就在这份计划上改一笔，最后一口气转成 ops
const planOf = (note) =>
  sectioned(note).map((r) => {
    const { section: _s, ...rest } = r.block
    return { id: r.block.id, section: r.section, block: rest, op: 'keep', old: null, outside: false }
  })

// 插到 after 后面；after 不在目标小节里（或那块已经不存在）就排在该小节末尾
const insertPlanned = (plan, entry, after) => {
  const target = after ? plan.find((x) => x.id === after) : null
  let at = target && target.section === entry.section ? plan.indexOf(target) : -1
  if (at < 0) {
    for (let i = 0; i < plan.length; i++) if (plan[i].section === entry.section) at = i
  }
  if (at < 0) plan.push(entry)
  else plan.splice(at + 1, 0, entry)
}

// 工具给的块内容过一遍 normalizeBlocks：未知类型 / 空内容会被洗干净或直接丢掉
const cleanBlock = (raw, section) => {
  const [b] = normalizeBlocks([{ ...(raw || {}), section }])
  if (!b) return null
  const { id: _id, section: sec, ...rest } = b
  return { section: sec, block: rest }
}

const reply = (content, summary = '') => ({ content, summary })

function runReviseTool(ctx, name, raw) {
  const args = raw && typeof raw === 'object' ? raw : {}
  const plan = ctx.plan
  const id = str(args.id).trim()
  const at = plan.findIndex((e) => e.id === id)
  const ids = () => plan.map((e) => e.id).join('、') || '（这一篇没有块）'
  const noSuch = () => reply(`没有 id 为「${id}」的块，这一下没生效。现有块 id：${ids()}`, '⚠ 找不到块')

  if (name === 'finish_revision') {
    ctx.title = stripMark(args.title)
    ctx.advice = str(args.advice).trim()
    ctx.done = true
    return reply('收到，这一轮结束。', '✅ 交差')
  }

  if (name === 'move_block') {
    if (at < 0) return noSuch()
    const section = secOk(args.section)
    if (!section) return reply(`section 只能是 ${SEC_IDS.join(' / ')}，这一下没生效。`, '⚠ 小节名不对')
    const [e] = plan.splice(at, 1)
    if (e.op === 'keep') {
      e.op = 'move'
      e.oldSection = e.section
    }
    e.section = section
    insertPlanned(plan, e, str(args.after).trim())
    return reply(`已把 ${e.id} 挪到「${secTitle(section)}」。`, `↔ 挪一块 → ${secTitle(section)}`)
  }

  if (name === 'rewrite_block') {
    if (at < 0) return noSuch()
    const e = plan[at]
    const got = cleanBlock(args.block, secOk(args.section) || e.section)
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没写进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    // 新建的块本来就还没进笔记，改写它不用记 old
    if (e.op !== 'add') {
      if (!e.old || e.op === 'keep') e.old = { ...e.block }
      e.op = 'replace'
    }
    e.block = got.block
    e.section = got.section
    if (args.outside === true) e.outside = true
    return reply(
      `已改写 ${e.id}。`,
      `✏ 改写一块（${TYPE_NAME[got.block.type] || got.block.type}）`,
    )
  }

  if (name === 'add_block') {
    const section = secOk(args.section)
    if (!section) return reply(`section 只能是 ${SEC_IDS.join(' / ')}，这一下没生效。`, '⚠ 小节名不对')
    const got = cleanBlock(args.block, section)
    if (!got)
      return reply('这块内容是空的、或者块类型不认识，没加进去。按块类型规范给全字段再调一次。', '⚠ 块不完整')
    const e = {
      id: `pending-${++ctx.seq}`,
      section: got.section,
      block: got.block,
      op: 'add',
      old: null,
      outside: args.outside === true,
    }
    insertPlanned(plan, e, str(args.after).trim())
    return reply(
      `已在「${secTitle(e.section)}」加了 1 块，临时 id 是 ${e.id}（后面还要动它就用这个 id）。`,
      `➕ 新增一块 → ${secTitle(e.section)}`,
    )
  }

  if (name === 'drop_block') {
    if (at < 0) return noSuch()
    const [e] = plan.splice(at, 1)
    // 这轮刚加的块还没真进笔记，撤掉就等于没加
    if (e.op === 'add') return reply('那块是这轮刚加的，已撤掉。', '🗑 撤销刚加的块')
    ctx.drops.push({ op: 'drop', id: e.id, block: e.old || e.block })
    return reply(`已删掉 ${e.id}。`, '🗑 删一块')
  }

  if (name === 'split_note') {
    const title = stripMark(args.title)
    if (!title) return reply('没给新篇标题，这一下没拆。', '⚠ 缺新篇标题')
    const picked = []
    for (const one of arr(args.ids).map((x) => str(x).trim())) {
      const i = plan.findIndex((x) => x.id === one)
      if (i < 0) continue
      const [e] = plan.splice(i, 1)
      if (e.op === 'add') continue
      picked.push({ id: e.id, block: e.old || e.block })
    }
    if (!picked.length) return reply(`这些 id 都没找到，没拆成。现有块 id：${ids()}`, '⚠ 没拆成')
    // 编不出来的分类就跟着原篇走：拆出去的子篇默认和母篇同一类
    const topicId = topicExists(str(args.topicId))
      ? str(args.topicId)
      : topicExists(ctx.note.topicId)
        ? ctx.note.topicId
        : fallbackTopicId()
    // 拆到同一篇的多组 split 归成一条，别在面板上出现两张一模一样的卡
    let op = ctx.splits.find((s) => s.to.title === title)
    if (!op) {
      op = { op: 'split', to: { title, topicId, why: str(args.why) }, blocks: [], ids: [] }
      ctx.splits.push(op)
    }
    for (const p of picked) {
      op.blocks.push({ ...p.block, id: p.id })
      op.ids.push(p.id)
    }
    return reply(`已把 ${picked.length} 块挪去《${title}》。`, `✂ 拆出 ${picked.length} 块 → 《${title}》`)
  }

  return reply(`没有叫 ${name} 的工具。`, '⚠ 工具不存在')
}

// 计划 → ops。挪回原段的不算挪（否则落库时会被当成「没变」而丢掉顺序）
const planToOps = (ctx) => [
  ...ctx.plan.map((e) => {
    const flag = e.outside ? { outside: true } : {}
    if (e.op === 'add') return { op: 'add', section: e.section, block: e.block, ...flag }
    if (e.op === 'replace')
      return { op: 'replace', id: e.id, section: e.section, block: e.block, old: e.old, ...flag }
    if (e.op === 'move' && e.section !== e.oldSection)
      return { op: 'move', id: e.id, section: e.section, oldSection: e.oldSection }
    return { op: 'keep', id: e.id }
  }),
  ...ctx.drops,
  ...ctx.splits,
]

// 对话线程别无限长：超过这么多条就从最早的一轮用户消息处切（system + 开场快照永远留着）
const MAX_THREAD = 26

function trimThread(list) {
  if (list.length <= MAX_THREAD) return list
  let cut = list.length - (MAX_THREAD - 2)
  while (cut < list.length - 1 && list[cut].role !== 'user') cut++
  return [list[0], list[1], ...list.slice(cut)]
}

// 一轮跑完交给下一轮的线程：工具调用留下的 tool_calls / tool 消息里没有 reasoning_content，
// 用户下次开着思考接着聊就会被 DeepSeek 400 拒掉。工具结果本身就是人话，压成一句接在
// 模型的回答后面，线程就成了纯对话 —— 思考开关怎么切都不炸，模型照样知道自己动过哪块
function settleThread(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m.role === 'tool') continue
    if (m.role !== 'assistant') {
      out.push({ ...m })
      continue
    }
    if (!m.tool_calls?.length) {
      out.push({ role: 'assistant', content: m.content })
      continue
    }
    const acts = []
    for (let j = i + 1; j < list.length && list[j].role === 'tool'; j++) {
      const one = str(list[j].content).trim()
      if (one) acts.push(one)
    }
    const said = str(m.content).trim()
    const did = acts.length ? `（这轮我调了工具：${acts.join('；')}）` : ''
    out.push({ role: 'assistant', content: [said, did].filter(Boolean).join('\n\n') || '（这轮没动）' })
  }
  return out
}

export async function reviseNote({
  note,
  instruction,
  cfg,
  related,
  allowSplit = false,
  outside = false,
  history = [],
  messages,
  onStep,
} = {}) {
  const cur = sectioned(note).map((r) => ({ ...r.block, section: r.section }))
  const rel = related === undefined ? relatedNotes(note) : arr(related)
  const relText = rel.length
    ? rel
        .map(
          (r, i) =>
            `${i + 1}. 《${r.title}》（${r.path || '未归类'}）${r.text ? `：${r.text}` : '（这篇还是空的）'}`,
        )
        .join('\n')
    : '（库里没有明显相邻的笔记，这篇可以独立成篇）'

  const conf = cfg || loadAI()
  const want = str(instruction).trim() || '按结构诊断把这篇理顺，缺的段落补上'
  const snap = `现有块（id 要原样引用）：\n${JSON.stringify(cur)}`
  const intro = `笔记标题：${note?.title || ''}

结构诊断（程序算的，比肉眼准）：
${diagnose(note).text}

库里相邻的笔记：
${relText}

${snap}
${allowSplit ? `\n分类树（split_note 的 topicId 从这里原样复制）：\n${topicCatalog()}\n` : ''}${roundsText(history)}
想要的改动：${want}`
  // 接着聊：把这一轮的现状和指令接在对话后面，模型记得自己前面改了什么、说过什么
  const follow = `这一轮现在的样子（是你前面几轮改完的成品；块 id 以这里为准，以前的 id 已经作废）：
${JSON.stringify(cur)}

这一轮要做的：${want}`

  // 有线程就沿用（真对话），没有就开一条新的；旧线程里可能还留着工具消息，这里再拍平一遍
  const thread = arr(messages).length
    ? [...settleThread(arr(messages)), { role: 'user', content: follow }]
    : [
        { role: 'system', content: reviseSystem(allowSplit, outside, thinkOn(conf)) },
        { role: 'user', content: intro },
      ]

  const ctx = { plan: planOf(note), note, drops: [], splits: [], done: false, title: '', advice: '', reply: '', seq: 0 }
  const tools = reviseTools(allowSplit)
  let fellBack = false
  // 思考开关一旦降级、或某一轮没产出思考内容，后面就一路关着：那几段 assistant 消息里
  // 没有 reasoning_content，思考模式下再发会被 DeepSeek 直接 400 拒掉
  let think = thinkOn(conf)

  // 一轮只想一个动作：不再要求模型一次吐出整篇 JSON，它想怎么改就调哪个工具
  for (let round = 0; round < MAX_REVISE_ROUNDS && !ctx.done; round++) {
    let res
    try {
      res = await chatStreamTools(thread, {
        cfg: think ? conf : { ...conf, thinking: 'off' },
        tools,
        temperature: 0.25,
        maxTokens: 2500,
        onNoThinking: () => {
          fellBack = true
        },
      })
    } catch (e) {
      // 整篇助手是靠工具一块块改的，模型不认 tools 就干不了活：直接说清该换模型
      if (e.noTools) throw new Error(`当前模型不支持工具调用（整篇助手需要），到「设置」换成 deepseek-chat 这类通用模型再试`)
      throw e
    }
    const { text, toolCalls, reasoning, thinking } = res
    // 它不调工具、直接说话了：放回对话线程里（用户能接着追问），已经改好的照旧保留
    if (!toolCalls.length) {
      const said = str(text).trim()
      if (said) {
        ctx.reply = said
        if (!ctx.advice) ctx.advice = said.replace(/\s+/g, ' ').slice(0, 120)
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
      const out = runReviseTool(ctx, c.function.name, args)
      if (onStep && out.summary) onStep(out.summary)
      thread.push({ role: 'tool', tool_call_id: c.id, content: out.content })
    }
  }

  return {
    title: stripMark(ctx.title),
    advice: ctx.advice,
    reply: ctx.reply,
    messages: trimThread(settleThread(thread)),
    related: rel,
    ops: normalizeOps(planToOps(ctx), note),
    noticed: fellBack,
  }
}

/* ---------- 把模型返回的 ops 掰正 ---------- */

// 模型可能给不存在的 id、把 add 当 replace、重复同一个块、挪到不存在的段，这里全部掰正
export function normalizeOps(raw, note) {
  const all = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const secOf = sectionsOf(note)
  const seen = new Set()
  const out = []

  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue
    let op = ['keep', 'move', 'replace', 'add', 'drop', 'split'].includes(item.op) ? item.op : ''
    const id = str(item.id)

    if (op === 'keep') {
      const ids = arr(item.ids).length ? arr(item.ids).map(str) : [id]
      for (const one of ids) {
        if (!all.has(one) || seen.has(one)) continue
        seen.add(one)
        out.push({ op: 'keep', id: one, block: all.get(one) })
      }
      continue
    }

    if (op === 'move') {
      const section = SECTIONS.some((s) => s.id === item.section) ? item.section : ''
      if (!all.has(id) || seen.has(id) || !section || section === secOf.get(id)) continue
      seen.add(id)
      out.push({ op: 'move', id, section, block: all.get(id), oldSection: secOf.get(id) })
      continue
    }

    if (op === 'drop') {
      if (!all.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ op: 'drop', id, block: all.get(id) })
      continue
    }

    if (op === 'split') {
      const to = item.to && typeof item.to === 'object' ? item.to : item
      const title = stripMark(to.title)
      if (!title) continue
      const ids = arr(item.ids).length ? arr(item.ids).map(str) : [id]
      const picked = []
      for (const one of ids) {
        if (!all.has(one) || seen.has(one)) continue
        seen.add(one)
        picked.push(all.get(one))
      }
      if (!picked.length) continue
      // 编不出来的分类就跟着原篇走：拆出去的子篇默认和母篇同一类
      const topicId = topicExists(str(to.topicId))
        ? str(to.topicId)
        : topicExists(note.topicId)
          ? note.topicId
          : fallbackTopicId()
      const why = str(to.why)
      // 拆到同一篇的多组 split 归成一条，别在面板上出现两张一模一样的卡
      const same = out.find((o) => o.op === 'split' && o.to.title === title)
      if (same) {
        same.blocks.push(...picked)
        same.ids.push(...picked.map((b) => b.id))
        if (!same.to.why && why) same.to.why = why
      } else {
        out.push({ op: 'split', to: { title, topicId, why }, blocks: picked, ids: picked.map((b) => b.id) })
      }
      continue
    }

    if (op === 'replace') {
      if (!all.has(id) || seen.has(id)) op = 'add'
      else seen.add(id)
    }
    if (!op) op = id && all.has(id) ? 'replace' : 'add'
    // 块内容模型有时放在 block 里、有时直接平铺在这一层
    const inner = item.block && typeof item.block === 'object' ? item.block : item
    // 改写没给 section 就留在原段，别让整块悄悄跑到「核心结论」
    const section = str(item.section) || str(inner.section) || (op === 'replace' ? secOf.get(id) : '')
    const [b] = normalizeBlocks([{ ...inner, section }])
    if (!b) continue
    const { id: _tmp, outside: _o, ...rest } = b
    // 库外标记挂在 op 上、不进块：写进去之后就是笔记自己的内容了，不需要长期带着「这是 AI 补的」
    const flag = item.outside === true || inner.outside === true ? { outside: true } : {}
    if (op === 'replace') out.push({ op, id, section: b.section, block: rest, old: all.get(id), ...flag })
    else out.push({ op: 'add', section: b.section, block: rest, ...flag })
  }
  return out
}

// 空段落不留在笔记里：heading 后面没块就别显示
const compact = (list) => {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const b = list[i]
    const next = list[i + 1]
    if (b.type === 'heading' && b.level === 2 && (!next || next.type === 'heading')) continue
    out.push(b)
  }
  return out
}

// 按用户勾过的行改写笔记；heading 由 assembleBlocks 重新生成。
// 顺手记一份 marks（块 id → 改/移/新），预览版靠它给成品上色；drop 掉的块不可能出现在成品里，另开一个集合
export function applyOps(note, rows) {
  const marks = new Map()
  const dropped = new Set()
  // 拆出去的内容按新篇标题归组，落库由调用方决定（这里只算，不建笔记）
  const splits = new Map()
  if (!note) return { marks, dropped, splits }
  const secOf = sectionsOf(note)
  const byId = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const items = []
  const done = new Set()
  const push = (section, block) => items.push({ ...block, section: section || 'core' })

  for (const r of rows) {
    if (r.op === 'keep') {
      const b = byId.get(r.id)
      if (b && !done.has(r.id)) {
        done.add(r.id)
        push(secOf.get(r.id), b)
      }
    } else if (r.op === 'move') {
      const b = byId.get(r.id)
      if (!b || done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) marks.set(r.id, 'move')
      push(r.checked ? r.section : secOf.get(r.id), b)
    } else if (r.op === 'replace') {
      if (done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) {
        marks.set(r.id, 'replace')
        push(r.section, { ...r.block, id: r.id })
      } else push(secOf.get(r.id), byId.get(r.id))
    } else if (r.op === 'add') {
      if (r.checked) {
        const id = newBlockId()
        push(r.section, { ...r.block, id })
        marks.set(id, 'add')
      }
    } else if (r.op === 'drop') {
      if (r.checked) {
        done.add(r.id)
        dropped.add(r.id)
      }
    } else if (r.op === 'split') {
      // 整组勾选：移到新篇的块在原篇里删掉，不必逐块勾
      if (!r.checked) continue
      const moved = arr(r.blocks)
      if (!moved.length) continue
      const key = str(r.to && r.to.title) || '拆分出来的笔记'
      if (!splits.has(key)) {
        splits.set(key, {
          title: key,
          topicId: str(r.to && r.to.topicId),
          why: str(r.to && r.to.why),
          blocks: [],
        })
      }
      const bag = splits.get(key)
      for (const b of moved) {
        if (done.has(b.id)) continue
        done.add(b.id)
        dropped.add(b.id)
        marks.set(b.id, 'split')
        bag.blocks.push(b)
      }
    }
  }
  // 模型漏掉的原块按原样留住，别悄悄吃掉用户写的东西
  for (const [id, b] of byId) {
    if (done.has(id)) continue
    push(secOf.get(id), b)
  }
  note.blocks = compact(assembleBlocks(items))
  return { marks, dropped, splits }
}
