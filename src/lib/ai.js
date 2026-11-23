// AI 接入：OpenAI 兼容的 /chat/completions
// key 只存本机 localStorage，和云同步 token 同一套信任模型
import { state, newBlockId } from './store.js'
import { buildContext, searchNotes, noteText, noteIsEmpty } from './retrieve.js'

const CFG_KEY = 'myknowledge.ai'

export const DEFAULT_AI = {
  base: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  key: '',
}

// 识图要单独的模型：DeepSeek 没有视觉，随便配一个能看图的就行
export const DEFAULT_VISION = {
  base: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4v-flash',
  key: '',
}

export function loadAI() {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) {
      const j = JSON.parse(raw) || {}
      return { ...DEFAULT_AI, ...j, vision: { ...DEFAULT_VISION, ...(j.vision || {}) } }
    }
  } catch (e) {
    console.warn('AI 配置读取失败', e)
  }
  return { ...DEFAULT_AI, vision: { ...DEFAULT_VISION } }
}

export const saveAI = (cfg) => localStorage.setItem(CFG_KEY, JSON.stringify(cfg))

// 只清文本模型的 key，视觉模型那套留着
export function clearAI() {
  const v = loadAI().vision
  if (v && v.key) localStorage.setItem(CFG_KEY, JSON.stringify({ vision: v }))
  else localStorage.removeItem(CFG_KEY)
}

export const isAiReady = (c) => Boolean(c && c.base && c.model && c.key)

const endpoint = (base) => {
  const b = String(base || '').trim().replace(/\/+$/, '')
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`
}

async function errText(res) {
  try {
    const j = await res.json()
    const m = j?.error?.message || j?.message || res.statusText
    return `${res.status} ${m}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}

export async function chat(messages, { cfg, temperature = 0.3, maxTokens = 3000 } = {}) {
  const c = cfg || loadAI()
  if (!isAiReady(c)) throw new Error('还没填 API Key，先到「设置」里配一下')
  const res = await fetch(endpoint(c.base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.key}`,
    },
    body: JSON.stringify({
      model: c.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  })
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content
  if (!text) throw new Error('模型没有返回内容')
  return text
}

// 同一套接口的流式版本：边收边显示，长答案不用干等
export async function chatStream(
  messages,
  { cfg, temperature = 0.3, maxTokens = 2000, onDelta, signal } = {},
) {
  const c = cfg || loadAI()
  if (!isAiReady(c)) throw new Error('还没填 API Key，先到「设置」里配一下')
  const res = await fetch(endpoint(c.base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.key}`,
    },
    body: JSON.stringify({
      model: c.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
    signal,
  })
  if (!res.ok) throw new Error(await errText(res))

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let delta = ''
      try {
        delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || ''
      } catch {
        continue
      }
      if (!delta) continue
      full += delta
      onDelta && onDelta(delta, full)
    }
  }
  if (!full) throw new Error('模型没有返回内容')
  return full
}

// 模型有时会包 ```json 或者前后加解释，这里只取中间那个对象
export function pickJson(text) {
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}

/* ---------- 分类树 ---------- */

// 给模型看的精简目录：d1 是域，t-xxx 是分类，缩进表示层级
export function topicCatalog() {
  const lines = []
  const walk = (domainId, depth) => {
    const kids = state.topics.filter((t) => t.domainId === domainId && t.parentId)
    const roots = state.topics.filter((t) => t.domainId === domainId && !t.parentId)
    const emit = (list, d) => {
      for (const t of list) {
        lines.push(`${'  '.repeat(d)}${t.id} ${t.name}`)
        emit(kids.filter((k) => k.parentId === t.id), d + 1)
      }
    }
    emit(roots, depth)
  }
  for (const d of state.domains) {
    lines.push(`${d.id} ${d.name}`)
    walk(d.id, 1)
  }
  return lines.join('\n')
}

export const topicExists = (id) => state.topics.some((t) => t.id === id)

// 推荐分类不可用时的兜底：该域第一个叶子
export function fallbackTopicId() {
  const leaf = state.topics.find(
    (t) => !state.topics.some((o) => o.parentId === t.id),
  )
  return leaf ? leaf.id : state.topics[0]?.id || ''
}

/* ---------- 块 schema ---------- */

export const SECTIONS = [
  { id: 'core', title: '核心结论' },
  { id: 'detail', title: '推导 / 细节' },
  { id: 'qa', title: '高频问法' },
  { id: 'pitfall', title: '我踩过的坑' },
  { id: 'todo', title: '待补' },
]

const BLOCK_SPEC = `
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
不要输出 heading 块，段落由程序按 section 字段自动生成。`

const SECTION_SPEC = `
每个块必须带 section 字段，取值：
- core     核心结论：只放**断言**（一句能被追问「凭什么」的话，带关键数字）；名词解释用 definition 放这里
- detail   推导 / 细节：支撑上面那句断言的东西（公式、前提、无偏性、与替代方案对比）
- qa       高频问法：面试官真会这么问的原话 + 答法
- pitfall  我踩过的坑：真答错过、做错过的事 + 怎么改
- todo     还没查清的先占位`

/* ---------- 把模型返回的块洗干净 ---------- */

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const arr = (v) => (Array.isArray(v) ? v : [])

const VALID = new Set([
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
const bid = () => `b-${Date.now().toString(36)}-${++seq}`

export function normalizeBlocks(list) {
  const out = []
  for (const raw of arr(list)) {
    if (!raw || typeof raw !== 'object') continue
    const type = VALID.has(raw.type) ? raw.type : 'paragraph'
    const section = SECTIONS.some((s) => s.id === raw.section) ? raw.section : 'core'
    const b = { id: bid(), type, section }
    if (type === 'paragraph') b.text = str(raw.text)
    else if (type === 'definition') {
      b.term = str(raw.term)
      b.text = str(raw.text)
      b.detail = str(raw.detail)
    } else if (type === 'formula') {
      b.latex = str(raw.latex)
      b.text = str(raw.text)
    } else if (type === 'comparison') {
      b.left = str(raw.left)
      b.right = str(raw.right)
      b.rows = arr(raw.rows).map((r) => ({ k: str(r?.k), a: str(r?.a), b: str(r?.b) }))
    } else if (type === 'qa') {
      b.question = str(raw.question)
      b.answer = str(raw.answer)
    } else if (type === 'pitfall') {
      b.text = str(raw.text)
      b.cause = str(raw.cause)
      b.avoid = str(raw.avoid)
    } else if (type === 'steps' || type === 'bulletList') {
      b.text = str(raw.text)
      b.items = arr(raw.items).map(str).filter(Boolean)
      if (!b.items.length) b.items = ['']
    } else if (type === 'callout') {
      b.tone = raw.tone === 'warn' ? 'warn' : 'tip'
      b.text = str(raw.text)
    } else b.text = str(raw.text)

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

// 去掉内部使用的 section 字段，只留真正的块字段
export const stripSection = (b) => {
  const { section, ...rest } = b
  return rest
}

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

// 把块按段落拼成一条完整的 blocks 序列（含 heading），用于新建笔记
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

/* ---------- L1：改一个块 ---------- */

export const AI_ACTIONS = [
  { id: 'polish', label: '润色', hint: '信息不变，更准更短', mode: 'replace' },
  { id: 'expand', label: '扩写', hint: '补推导、前提、对比', mode: 'replace' },
  { id: 'split', label: '拆成知识块', hint: '长段落拆成多张卡', mode: 'replace' },
  { id: 'qa', label: '造高频问法', hint: '生成面试官会问的题', mode: 'insert', target: '高频问法' },
  { id: 'pitfall', label: '造踩坑卡', hint: '生成易错点', mode: 'insert', target: '我踩过的坑' },
]

const blockText = (b) =>
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

export async function rewriteBlock({ action, block, note, sectionTitle, cfg }) {
  const spec = ACTION_PROMPT[action]
  if (!spec) throw new Error('未知的 AI 动作')
  const system = `你在改写一篇数据分析面试知识笔记里的一个块。
${BLOCK_SPEC}
${SECTION_SPEC}

${spec}
只输出一个 JSON 对象：{"blocks":[{"type":"...","section":"...",...}]}`

  const user = `${noteContext(note, sectionTitle, block)}
当前块：[${block.type}] ${blockText(block)}`

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.4, maxTokens: 2500 },
  )
  const data = pickJson(text)
  const blocks = normalizeBlocks(data.blocks)
  if (!blocks.length) throw new Error('模型没给出可用内容，换个说法再试')
  return blocks
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

export async function fileAnswer({ question, answer, used = [], cfg } = {}) {
  const notes = state.notes
  const picked = []
  const seen = new Set()
  // 被引用过的笔记排前面：这次问答大概率跟它们同主题
  for (const s of used) {
    const n = notes.find((x) => x.id === s.id)
    if (n && !seen.has(n.id)) {
      seen.add(n.id)
      picked.push(n)
    }
  }
  for (const n of notes) {
    if (picked.length >= 150) break
    if (!seen.has(n.id)) {
      seen.add(n.id)
      picked.push(n)
    }
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
1. 该新建一篇笔记，还是追加进已有的某一篇。已有笔记讲的就是同一个主题就必须追加，别造重复笔记；主题确实不同才新建。
2. 把回答重排成结构化知识块，按语义放对段落 —— 不要偷懒把整条答案原样塞进一张问答卡。
${BLOCK_SPEC}
${SECTION_SPEC}

额外要求：
- 回答里的 [1] [2] 这类引用编号原样保留，不要改号、不要新增；让它们落在 paragraph 的 text 或 qa 的 answer 里。
- 除了「面试官会怎么问」那种一句话提问，其余内容都拆成 paragraph / definition / formula / bulletList / steps / comparison。
- 只写回答里真有的信息，别补数字、论文名、案例；缺信息用 todo 占位。
- target 为 exist 时，noteId 必须原样复制笔记列表里出现过的 id，段落优先沿用那篇笔记已有的段落标题。
- target 为 new 时，topicId 必须原样复制分类树里出现过的 id；title 要短，不带书名号。
- reason 用一句话说明为什么这么归类，会展示给用户看。

只输出一个 JSON 对象：
{"target":"new|exist","title":"...","topicId":"...","noteId":"...","section":"core|detail|qa|pitfall|todo","reason":"...","blocks":[{"type":"...","section":"...",...}]}`

  const user = `分类树：\n${topicCatalog()}\n\n已有笔记（id｜标题｜位置｜段落｜开头）：\n${lines.join('\n') || '（还没有笔记）'}\n\n面试官会怎么问：\n${question}\n\n回答：\n${answer}`

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.2, maxTokens: 4000 },
  )
  const data = pickJson(text)
  const blocks = normalizeBlocks(data.blocks)
  if (!blocks.length) throw new Error('模型没切出可用的内容，重试一次')

  const noteId = str(data.noteId)
  const target = data.target === 'exist' && notes.some((n) => n.id === noteId) ? 'exist' : 'new'
  const section = SECTIONS.some((s) => s.id === data.section) ? data.section : blocks[0].section || 'core'
  return {
    target,
    title: str(data.title),
    topicId: topicExists(data.topicId) ? data.topicId : fallbackTopicId(),
    noteId: target === 'exist' ? noteId : '',
    section,
    reason: str(data.reason),
    blocks,
  }
}

// 设置页的连通性测试
export async function ping(cfg) {
  const text = await chat(
    [
      { role: 'system', content: '只回复 ok' },
      { role: 'user', content: 'ping' },
    ],
    { cfg, temperature: 0, maxTokens: 8 },
  )
  return text.trim()
}

/* ---------- L3：问整个知识库 ---------- */

// 回答里用这一行切开「引你自己的笔记」和「模型自己的知识」
export const OUTSIDE_MARK = '【库外】'

const ASK_SYSTEM = `你是这个私人知识库的问答助手。用户是准备数据分析 / AB 实验 / 因果推断面试的人，库里是他自己写的笔记。

规则：
- 先依据「资料」回答。来自资料的每条具体结论后面标来源，写成 [1]、[2]，编号必须是资料里出现过的编号。
- 资料里没有、但你确实知道的内容，另起一段，以「${OUTSIDE_MARK}」开头，让用户一眼看出那不是他自己的笔记。没有这类内容就不要写这一段。
- 资料里没有、你也拿不准的，直接说「库里还没有」，再补一句最接近的是哪一篇、还缺什么。
- 不要编造数字、论文名、公司案例。用户笔记里没有的具体数字不要补。
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。
- 用户问「有哪些 / 列一下」时，把资料里相关的都列出来，一条一行，每条都带来源。
- 用户的笔记互相矛盾时，指出来是哪两篇、分别怎么写的，不要替他和稀泥。`

// 只查笔记模式：一个字都不许超出资料，面试前怕被带偏时用
const ASK_STRICT = `你是这个私人知识库的问答助手。用户是准备数据分析 / AB 实验 / 因果推断面试的人，库里是他自己写的笔记。

规则：
- 只能依据「资料」回答。每条具体结论后面标来源，写成 [1]、[2]，编号必须是资料里出现过的编号。
- 资料里没写的，直接说「库里还没有」，再说最接近的是哪一篇、还缺什么，然后就停。
- 禁止用你自己的通用知识补充，禁止写「${OUTSIDE_MARK}」段落，禁止编造数字、论文名、公司案例。
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。
- 用户问「有哪些 / 列一下」时，把资料里相关的都列出来，一条一行，每条都带来源。`

export async function askLibrary({
  question,
  history = [],
  cfg,
  strict = false,
  onDelta,
  signal,
} = {}) {
  // 追问「那它的假设是什么」里没有关键词，只按这一句检索会漏到别的笔记上；
  // 把上一轮的问题也带上（只算半票），当前这句仍然是主角
  const prevQ = [...history].reverse().find((m) => m.role === 'user')?.content || ''
  const { empty, text: ctx, used, fallback } = buildContext(question, { extra: prevQ })
  if (empty) throw new Error('库里还没有笔记，先写一篇再来问')

  const head = fallback
    ? `资料（没有明显命中，下面是最近改过的几篇；如果都不相关就直说库里没有）：`
    : `资料（从用户知识库里检索出来的 ${used.length} 篇）：`
  const messages = [
    { role: 'system', content: `${strict ? ASK_STRICT : ASK_SYSTEM}\n\n${head}\n${ctx}` },
    ...history.slice(-6),
    { role: 'user', content: question },
  ]

  const text = await chatStream(messages, {
    cfg,
    temperature: strict ? 0.1 : 0.2,
    maxTokens: 1600,
    onDelta,
    signal,
  })
  return { text, used, fallback, strict }
}

/* ---------- L3.5：agent —— 模型自己查、自己读、自己归档 ---------- */

// 工具轮数上限：正常的问答 1～3 轮就够，6 轮还没收尾说明它在瞎转
export const MAX_ROUNDS = 6

const SECTION_IDS = ['core', 'detail', 'qa', 'pitfall', 'todo']

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
        '读一篇笔记的完整正文（按小节分）。标题看起来对口时一定要读，不要只凭标题判断里面写了什么。',
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
        '提交一份归档提案（不会直接写盘，用户要确认）。只有用户让你存成笔记时才调用。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['new', 'exist'],
            description: '新建一篇填 new，追加进已有笔记填 exist',
          },
          noteId: {
            type: 'string',
            description: 'mode=exist 时必填，必须在 search_notes / read_note 里出现过',
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
            description: '内容块，每块按语义放对 section',
            items: {
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
            },
          },
        },
        required: ['mode', 'reason', 'blocks'],
      },
    },
  },
]

// 带 tools 的流式请求：正文边收边显示，顺带把 tool_calls 拼起来
export async function chatStreamTools(
  messages,
  { cfg, tools, temperature = 0.2, maxTokens = 2000, onDelta, signal } = {},
) {
  const c = cfg || loadAI()
  if (!isAiReady(c)) throw new Error('还没填 API Key，先到「设置」里配一下')
  const body = { model: c.model, messages, temperature, max_tokens: maxTokens, stream: true }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const res = await fetch(endpoint(c.base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.key}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const msg = await errText(res)
    const e = new Error(msg)
    // 有的兼容端点压根不认 tools / functions，这种就退回老的预检索流程
    if (/tool|function/i.test(msg)) e.noTools = true
    throw e
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  const calls = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let delta
      try {
        delta = JSON.parse(payload)?.choices?.[0]?.delta
      } catch {
        continue
      }
      if (!delta) continue
      if (delta.content) {
        full += delta.content
        onDelta && onDelta(delta.content, full)
      }
      for (const [i, tc] of (delta.tool_calls || []).entries()) {
        const at = Number.isInteger(tc.index) ? tc.index : i
        const cur =
          calls[at] || (calls[at] = { id: '', type: 'function', function: { name: '', arguments: '' } })
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.function.name += tc.function.name
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
      }
    }
  }
  const toolCalls = calls
    .filter(Boolean)
    .filter((x) => x.function.name)
    .map((x, i) => ({ ...x, id: x.id || `call_${Date.now().toString(36)}_${i}` }))
  return { text: full, toolCalls }
}

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
      const n = citeIndex(ctx, state.notes.find((x) => x.id === h.id) || h)
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
    const note = state.notes.find((x) => x.id === str(args.id))
    if (!note) {
      return { content: `没有 id 为 ${str(args.id)} 的笔记，用 search_notes 重新查。`, summary: '📖 读不到（id 不对）' }
    }
    const n = citeIndex(ctx, note)
    const empty = noteIsEmpty(note)
    return {
      content: `[${n}] ${noteText(note)}`,
      summary: `📖 读《${note.title}》→ ${empty ? '空笔记' : '正文'} `,
    }
  }

  if (name === 'list_topics') {
    return { content: `分类树：\n${topicCatalog()}`, summary: '🗂 看分类树' }
  }

  if (name === 'save_note') {
    const blocks = normalizeBlocks(args.blocks)
    if (!blocks.length) {
      return {
        content: 'blocks 为空或不合法，提案没有记录。请重新调用 save_note，给出至少一个真正有内容的块。',
        summary: '🗂 提案无效（blocks 为空）',
      }
    }
    const note = state.notes.find((x) => x.id === str(args.noteId))
    const mode = args.mode === 'exist' && note ? 'exist' : 'new'
    const topicId = mode === 'exist' ? note.topicId : topicExists(args.topicId) ? args.topicId : fallbackTopicId()
    ctx.proposal = {
      target: mode,
      title: str(args.title),
      topicId,
      noteId: mode === 'exist' ? note.id : '',
      section: SECTIONS.some((s) => s.id === args.section) ? args.section : blocks[0].section || 'core',
      reason: str(args.reason),
      blocks,
    }
    const where =
      mode === 'exist'
        ? `写进《${note.title}》${blocks.length} 块`
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
  onTrace,
  signal,
} = {}) {
  if (!isAiReady(cfg || loadAI())) throw new Error('还没填 API Key，先到「设置」里配一下')
  const msgs = [...messages]
  const ctx = { refs: refs.map((r) => ({ ...r })), proposal: null }
  let answer = ''
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { text, toolCalls } = await chatStreamTools(msgs, {
      cfg,
      tools: TOOLS,
      temperature: strict ? 0.1 : 0.25,
      maxTokens,
      onDelta,
      signal,
    })
    if (!toolCalls.length) {
      answer = text
      msgs.push({ role: 'assistant', content: text })
      break
    }
    msgs.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: c.function })),
    })
    for (const call of toolCalls) {
      const out = runTool(ctx, call)
      onTrace && onTrace(out.summary)
      msgs.push({ role: 'tool', tool_call_id: call.id, content: out.content })
    }
  }
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
- 笔记里没有、但你确实知道的：另起一段，以「${OUTSIDE_MARK}」开头，把该讲的内容讲清楚、讲完整；整段讲完，最多用一句话说明库里哪篇最接近、还缺什么。不要把「库里缺什么」写在开头当成答案。
- read_note 显示某篇只有小节标题没有正文时，就说「库里那篇《X》还是空的」。它的标题只能当成「这个话题还打算写」，不能当成已有结论引用。
- 不要编造数字、论文名、公司案例。笔记里没有的具体数字不要补。
- 用户问「有哪些 / 列一下」时，把查到的都列出来，一条一行，每条带 [n]。
- 笔记之间说法冲突时，指出是哪两篇、各自怎么写，别替他打圆场。
- 除非用户明确让你存成笔记，否则不要调用 save_note。`

const AGENT_STRICT = `${AGENT_RULES}

只查笔记模式（用户面试前怕被带偏，一个字都不许超出笔记）：
- 只能依据 read_note / search_notes 拿到的内容回答，每条具体结论都带 [n]。
- 禁止用你自己的通用知识补充，禁止写「${OUTSIDE_MARK}」段落，禁止编造数字、论文名、公司案例。
- 笔记里没写的直接说「库里还没有」，再说最接近哪一篇、缺什么，然后就停。
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。`

// history 只放最近几轮问答，别把整段对话灌进去
export function askAgent({ question, history = [], cfg, strict = false, ...rest } = {}) {
  const messages = [
    { role: 'system', content: strict ? AGENT_STRICT : AGENT_RULES + AGENT_ANSWER },
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ]
  return agentRun({ messages, cfg, strict, ...rest })
}

const ARCHIVE_NUDGE = `把上面这轮问答存进知识库：
- 先 search_notes 查有没有同主题的笔记。空骨架的也算同主题，内容直接填进那篇，不要另建重复的。
- 需要的话 read_note 看它已有的小节标题，好把内容插对地方。
- 然后调用 save_note 提交提案：mode、noteId 或 topicId、reason、blocks。
- blocks 要按语义分块（paragraph / definition / formula / qa / pitfall / steps / comparison），别把整篇答案塞进一张问答卡。
- 回答里的 [1] [2] 这些编号原样保留。
- 这里的回答是给归档器看的，不用长篇解释；提案提交完说一句归档到哪了就停。`

// 沿着问答那轮的同一个会话往下走：模型还记着刚才查过什么，判断更准
export function archiveAgent({ messages, refs = [], cfg, onTrace, signal } = {}) {
  const next = [...messages, { role: 'user', content: ARCHIVE_NUDGE }]
  return agentRun({ messages: next, refs, cfg, maxTokens: 2000, onTrace, signal })
}

/* ---------- 识图：截图 → LaTeX / 文字 ---------- */
// 图片先缩到长边 1600 再转 base64：请求体不至于几十 MB，慢网也能发出去
export async function imageToDataUrl(source, { maxSide = 1600, quality = 0.85 } = {}) {
  let blob = source
  if (typeof source === 'string') {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`图片读不到（HTTP ${res.status}）`)
    blob = await res.blob()
  }
  if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('这不是图片')

  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((ok, no) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => no(new Error('图片解码失败'))
      i.src = url
    })
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    cv.getContext('2d').drawImage(img, 0, 0, w, h)
    return cv.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const OCR_SYSTEM = `你帮人把图里的内容抄成能编辑的东西，图多半是统计 / 机器学习公式的截图。
只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏：
- 图里是公式：{"kind":"formula","latex":"...","text":"一句话说这是什么"}
- 图里是文字 / 表格 / 代码：{"kind":"text","text":"按原样抄，保留换行"}

latex 用单反斜杠，不要用 $ 包裹，不要 \\begin{equation} 这类环境。
看不清的地方宁可写 \\text{?}，也不许猜一个看起来合理的式子。`

export async function ocrImage({ src, cfg } = {}) {
  const c = cfg || loadAI()
  const v = c.vision || DEFAULT_VISION
  if (!isAiReady(v))
    throw new Error('还没配视觉模型，去「设置 → 视觉模型」加一个能看图的（智谱 glm-4v-flash 免费）')

  const dataUrl = await imageToDataUrl(src)
  const text = await chat(
    [
      { role: 'system', content: OCR_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '把这张图转成 JSON。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { cfg: v, temperature: 0.1, maxTokens: 1200 },
  )
  const data = pickJson(text)
  return {
    kind: data.kind === 'text' ? 'text' : 'formula',
    latex: str(data.latex),
    text: str(data.text),
  }
}

/* ---------- 整篇改写：把笔记当一份稿子重排 ---------- */

// 块属于哪一段：靠前面的 heading 推
export function sectioned(note) {
  const out = []
  let cur = SECTIONS[0].id
  for (const b of note?.blocks || []) {
    if (b.type === 'heading' && b.level === 2) {
      const hit = SECTIONS.find((s) => s.title === b.text)
      if (hit) cur = hit.id
      continue
    }
    out.push({ section: cur, block: b })
  }
  return out
}

const sectionsOf = (note) => new Map(sectioned(note).map((r) => [r.block.id, r.section]))

const REVISE_SYSTEM = `你在改一篇数据分析面试知识笔记的结构。用户会给你现有内容和想要的改动。

${BLOCK_SPEC}
${SECTION_SPEC}

规则：
- 按最终顺序列出所有块，每个块带一个 op：
  keep    原样保留，只需给 id
  replace 改写已有块，给 id + block（新内容，type 可以换）
  add     新增块，给 section + block
  drop    删掉已有块，只需给 id
- block 里放块字段（type + BLOCK_SPEC 里对应的字段），section 放在 op 这一层。
- 指令没提到的块一律 keep，不要顺手润色、不要改变顺序。
- 不要编造具体数字、论文名、公司案例；缺信息就写 todo 块占位。
- 不要输出 heading 块，段落由 section 字段决定。
- title 只在指令明确要求改标题时才给，否则省略这个字段。
只输出一个 JSON 对象：{"title":"...","ops":[{"op":"keep","id":"..."},{"op":"add","section":"core","block":{"type":"paragraph","text":"..."}}]}`

export async function reviseNote({ note, instruction, cfg } = {}) {
  const cur = sectioned(note).map((r) => ({ ...r.block, section: r.section }))
  const user = `笔记标题：${note?.title || ''}

现有块（id 要原样引用）：
${JSON.stringify(cur)}

想要的改动：${instruction}`

  const text = await chat(
    [
      { role: 'system', content: REVISE_SYSTEM },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.3, maxTokens: 4000 },
  )
  const data = pickJson(text)
  return {
    title: str(data.title),
    ops: normalizeOps(data.ops || data.blocks, note),
  }
}

// 模型可能给不存在的 id、把 add 当 replace、重复同一个块，这里全部掰正
export function normalizeOps(raw, note) {
  const all = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const seen = new Set()
  const out = []
  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue
    const id = str(item.id)
    let op = ['keep', 'replace', 'add', 'drop'].includes(item.op) ? item.op : ''
    if (!op) op = id && all.has(id) ? 'replace' : 'add'

    if (op === 'keep' || op === 'drop') {
      if (!all.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ op, id, block: all.get(id) })
      continue
    }
    if (op === 'replace') {
      if (!all.has(id) || seen.has(id)) op = 'add'
      else seen.add(id)
    }
    // 块内容模型有时放在 block 里、有时直接平铺在这一层
    const inner = item.block && typeof item.block === 'object' ? item.block : item
    const section = str(item.section) || str(inner.section)
    const [b] = normalizeBlocks([{ ...inner, section }])
    if (!b) continue
    const { id: _tmp, ...rest } = b
    if (op === 'replace') out.push({ op, id, section: b.section, block: rest, old: all.get(id) })
    else out.push({ op: 'add', section: b.section, block: rest })
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

// 按用户勾过的行改写笔记；heading 由 assembleBlocks 重新生成
export function applyOps(note, rows) {
  if (!note) return
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
    } else if (r.op === 'replace') {
      if (done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) push(r.section, { ...r.block, id: r.id })
      else push(secOf.get(r.id), byId.get(r.id))
    } else if (r.op === 'add') {
      if (r.checked) push(r.section, { ...r.block, id: newBlockId() })
    } else if (r.op === 'drop') {
      if (r.checked) done.add(r.id)
    }
  }
  // 模型漏掉的原块按原样留住，别悄悄吃掉用户写的东西
  for (const [id, b] of byId) {
    if (done.has(id)) continue
    push(secOf.get(id), b)
  }
  note.blocks = compact(assembleBlocks(items))
}
