// AI 接入：OpenAI 兼容的 /chat/completions
// key 只存本机 localStorage，和云同步 token 同一套信任模型
import { state } from './store.js'
import { buildContext } from './retrieve.js'

const CFG_KEY = 'myknowledge.ai'

export const DEFAULT_AI = {
  base: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  key: '',
}

export function loadAI() {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) return { ...DEFAULT_AI, ...JSON.parse(raw) }
  } catch (e) {
    console.warn('AI 配置读取失败', e)
  }
  return { ...DEFAULT_AI }
}

export const saveAI = (cfg) => localStorage.setItem(CFG_KEY, JSON.stringify(cfg))
export const clearAI = () => localStorage.removeItem(CFG_KEY)
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
    if (!items.length && sec.id === 'todo') continue
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
  const { empty, text: ctx, used, fallback } = buildContext(question)
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
