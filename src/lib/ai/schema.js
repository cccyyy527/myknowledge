// 块的 schema 与清洗：五段定义、块字段规范、模型返回值的规范化



/* ---------- 块 schema ---------- */

export const SECTIONS = [
  { id: 'core', title: '核心结论' },
  { id: 'detail', title: '推导 / 细节' },
  { id: 'qa', title: '高频问法' },
  { id: 'pitfall', title: '我踩过的坑' },
  { id: 'todo', title: '待补' },
]

export const BLOCK_SPEC = `
可用块类型与字段（只准用这些 type）：
- paragraph   { text }                          一段叙述
- definition  { term, text, detail }            概念卡：术语 / 一句话定义 / 展开（detail 可空）
- formula     { latex, text }                   公式：LaTeX（单反斜杠、不要 $）+ 变量或解读
- comparison  { left, right, rows:[{k,a,b}] }   对比卡：左右两个方案 + 对比行
- qa          { question, answer }              问答卡：面试官原话 + 你的答法
- pitfall     { text, cause, avoid }            坑卡：现象 / 原因 / 怎么避免
- steps       { text, items:[...] }             步骤卡
- callout     { tone:'tip'|'warn', text }       提示卡
- bulletList  { items:[...] }                   列表
- code        { text }                          代码
- todo        { text }                          还没查清的占位
不要输出 heading 块，段落由程序按 section 字段自动生成。

text / answer / detail 这些长文本字段里可以用 \\n 换行，界面上会真的断行。适合「一句话结论 + 换行 + 一句限定」这种两行式写法；但别用换行去模仿表格或多级缩进，那属于该拆块的情况。
关键字可以用 **两个星号** 加粗，行内术语可以用 \`反引号\` 标成代码。加粗只留给真正要扫一眼的关键词，一段里别超过两处。

引用别的笔记：正文里提到库里另一篇笔记讲的东西时，写 [[那篇的完整标题]]（中文方括号要写两遍、标题一个字都不能改）。找不到确切标题就别硬编，宁可不用。
- 整段只有这一个引用、没有别的话时，会渲染成一张跳转卡片，适合放在某段里做「相关」。
- 标题对不上任何一篇时，界面上会显示成虚线「未创建」，点一下才新建。`

export const SECTION_SPEC = `
每个块必须带 section 字段，取值：
- core     核心结论：只放**断言**（一句能被追问「凭什么」的话，带关键数字）；名词解释用 definition 放这里
- detail   推导 / 细节：支撑上面那句断言的东西（公式、前提、无偏性、与替代方案对比）
- qa       高频问法：面试官真会这么问的原话 + 答法
- pitfall  我踩过的坑：真答错过、做错过的事 + 怎么改
- todo     还没查清的先占位`

/* ---------- 把模型返回的块洗干净 ---------- */

export const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
export const arr = (v) => (Array.isArray(v) ? v : [])

// 回答里用这一行切开「引你自己的笔记」和「模型自己的知识」。
// 只给程序认，正文渲染和写进笔记之前都要削掉，用户永远看不到这几个字。
export const OUTSIDE_MARK = '【库外】'
const MARK_RE = /【\s*库外(?:补充)?\s*】/g

// 块 id / 笔记 id 只给工具认（read_note 用它指块、save_note 的 blockId 填它），
// 模型偶尔会把 [#b-xxxx] 这类编号抄进回答正文，渲染和落盘前一律削掉
const ID_MARK_RE = /\[#[^\]\n]{1,40}\]/g
// 独立的不带 g 的版本：带 g 的正则 test() 会记状态，连着调用结果会来回跳
const hasIdMark = (s) => /\[#[^\]\n]{1,40}\]/.test(s)

// 削掉编号后顺手把留下的空格和悬空标点收干净：「四项 [#a] [#b]、三组」→「四项、三组」
const tidyIds = (s) =>
  s
    .replace(/[ \t]*\[#[^\]\n]{1,40}\][ \t]*/g, ' ')
    .replace(/[ \t]+([，。、；：！？,.!?;:）)])/g, '$1')
    .replace(/([（(])[ \t]+/g, '$1')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+$/gm, '')

// 写进笔记、渲染之前都把标记抹掉，内容整段保留 —— 落盘时不再区分「库内 / 库外」
export const stripMark = (v) => {
  const s = str(v).replace(MARK_RE, '')
  // 没出现编号就原样返回，免得动到别的正文排版
  return (hasIdMark(s) ? tidyIds(s) : s).trim()
}

export const VALID = new Set([
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
])

let seq = 0
export const bid = () => `b-${Date.now().toString(36)}-${++seq}`

export function normalizeBlocks(list) {
  const out = []
  for (const raw of arr(list)) {
    if (!raw || typeof raw !== 'object') continue
    const type = VALID.has(raw.type) ? raw.type : 'paragraph'
    const section = SECTIONS.some((s) => s.id === raw.section) ? raw.section : 'core'
    const b = { id: bid(), type, section }
    if (type === 'paragraph') b.text = stripMark(raw.text)
    else if (type === 'definition') {
      b.term = stripMark(raw.term)
      b.text = stripMark(raw.text)
      b.detail = stripMark(raw.detail)
    } else if (type === 'formula') {
      b.latex = str(raw.latex)
      b.text = stripMark(raw.text)
    } else if (type === 'comparison') {
      b.left = stripMark(raw.left)
      b.right = stripMark(raw.right)
      b.rows = arr(raw.rows).map((r) => ({ k: str(r?.k), a: stripMark(r?.a), b: stripMark(r?.b) }))
    } else if (type === 'qa') {
      b.question = stripMark(raw.question)
      b.answer = stripMark(raw.answer)
    } else if (type === 'pitfall') {
      b.text = stripMark(raw.text)
      b.cause = stripMark(raw.cause)
      b.avoid = stripMark(raw.avoid)
    } else if (type === 'steps' || type === 'bulletList') {
      b.text = stripMark(raw.text)
      b.items = arr(raw.items).map(stripMark).filter(Boolean)
      if (!b.items.length) b.items = ['']
    } else if (type === 'callout') {
      b.tone = raw.tone === 'warn' ? 'warn' : 'tip'
      b.text = stripMark(raw.text)
    } else b.text = stripMark(raw.text)

    const blank =
      type === 'qa'
        ? !b.question && !b.answer
        : type === 'pitfall'
          ? !b.text && !b.cause
          : type === 'definition'
            ? !b.term && !b.text
            : type === 'comparison'
              ? !b.rows.length
              : !(b.items ? b.items.join('') : b.text || b.latex)
    if (!blank) out.push(b)
  }
  return out
}

// 一条答案是从问答来的，不代表它的内容属于「高频问法」。模型没拿到段落规范时
// 容易图省事把整条答案都标成 qa，落库后那篇笔记就只剩一堆问答卡、断言和推导全没归位。
// 判据：全塞进 qa、且真写成问答卡的不到一半 —— 这就是没按语义归位。
export function sectionDumpIssue(blocks) {
  const list = arr(blocks)
  if (list.length < 2) return ''
  if (list.some((b) => (b.section || 'core') !== 'qa')) return ''
  const cards = list.filter((b) => b.type === 'qa').length
  if (cards * 2 >= list.length) return ''
  return `这 ${list.length} 块全标成了 qa（高频问法），但其中只有 ${cards} 块真是问答卡。段落按内容语义定，跟这次内容从哪来无关：能站住的断言进 core，公式 / 前提 / 推导 / 对比进 detail，只有「面试官会这么问 + 我怎么答」的卡才进 qa。`
}

// 去掉内部使用的 section 字段，只留真正的块字段
export const stripSection = (b) => {
  const { section, ...rest } = b
  return rest
}

/* ---------- 工具参数：给模型的 function schema ---------- */

export const SEC_IDS = SECTIONS.map((s) => s.id)
export const secTitle = (id) => (SECTIONS.find((s) => s.id === id) || SECTIONS[0]).title
export const secOk = (v) => (SEC_IDS.includes(str(v)) ? str(v) : '')

// 与 BLOCK_SPEC 一一对应：这里只列字段名，怎么填靠 system 里那段说明
export const BLOCK_ARG = {
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

export const AFTER_ARG = { type: 'string', description: '插到哪一块后面（块 id）；省略就排在该小节末尾' }
export const OUTSIDE_ARG = { type: 'boolean', description: '这块用了笔记之外的知识才填 true' }

/* ---------- 把块按段落拼成一条完整的 blocks 序列（含 heading），用于新建笔记 ---------- */
export function assembleBlocks(blocks) {
  let i = 0
  const hid = () => `b-h-${Date.now().toString(36)}-${++i}`
  const out = []
  for (const sec of SECTIONS) {
    const items = blocks.filter((b) => (b.section || 'core') === sec.id)
    // 空段落不生成标题：留着只有一行空 heading，读起来像没写完
    if (!items.length) continue
    out.push({ id: hid(), type: 'heading', level: 2, text: sec.title })
    for (const b of items) out.push({ id: hid(), ...stripSection(b) })
  }
  return out
}
