// 传输层：配置读写、请求超时与重试、SSE 解析、模型返回的 JSON 容错



const CFG_KEY = 'myknowledge.ai'

export const DEFAULT_AI = {
  base: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  key: '',
  // DeepSeek 默认开思考模式，会把 max_tokens 烧在链式思考上导致正文为空；写字类活默认关掉
  thinking: 'off',
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

// 等待上限：模型再慢也不该让界面永远停在「生成中」，超时就报错让用户重试
const TIMEOUT_MS = 120000

// 把外部 signal 和超时合成一个：哪个先触发都中断请求
function guard(signal, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    ctrl.abort(
      new DOMException(`等了 ${Math.round(timeoutMs / 1000)} 秒还没有回包，先停了`, 'TimeoutError'),
    )
  }, timeoutMs)
  const onAbort = () => ctrl.abort(signal.reason)
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    done() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

// 服务端临时状态码：这类失败重试一次往往就好了，不该让整轮问答白跑
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504])

// DeepSeek V4 系列默认开思考模式（effort=high）：写笔记这类活用不上，更麻烦的是它会在
// 给出正文前把 max_tokens 全花在链式思考上，正文为空 —— 表现出来就是「模型没有返回内容」。
// 别家接口不认这个字段（OpenAI 会直接 400），所以只对 DeepSeek 发。
function thinkingOf(c) {
  if (!/deepseek\.com/i.test(c.base || '')) return {}
  return { thinking: { type: c.thinking === 'on' ? 'enabled' : 'disabled' } }
}

// 思考过程（reasoning_content）也算在 max_tokens 里：开了思考还要原来的正文额度，
// 就得另给思考留一份，否则它想完就没地方写正文了 —— 那正是「开了思考就不出内容」的原因。
const THINK_EXTRA = 4096

const thinkOn = (c) => c?.thinking === 'on' && /deepseek\.com/i.test(c.base || '')

// 只在真开思考时加预算，关着的时候行为和以前完全一样
// 上限 8192 是 deepseek 单次输出的天花板，超了直接 400，所以加完要收一下
const THINK_CAP = 8192
const budgetOf = (maxTokens, cfg) =>
  thinkOn(cfg || loadAI()) ? Math.min(maxTokens + THINK_EXTRA, THINK_CAP) : maxTokens

// 所有请求都走这里：端点 / 鉴权 / 超时 / 取消只管一份，read 负责把 response 读成值
async function request(cfg, body, { signal, timeoutMs, retry = 1 } = {}, read) {
  const c = cfg || loadAI()
  if (!isAiReady(c)) throw new Error('还没填 API Key，先到「设置」里配一下')
  for (let attempt = 0; ; attempt++) {
    const g = guard(signal, timeoutMs)
    try {
      const res = await fetch(endpoint(c.base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.key}`,
        },
        body: JSON.stringify({ model: c.model, ...thinkingOf(c), ...body }),
        signal: g.signal,
      })
      if (!res.ok) {
        const e = new Error(await errText(res))
        e.status = res.status
        throw e
      }
      return await read(res)
    } catch (e) {
      if (attempt >= retry || !RETRY_STATUS.has(e.status) || signal?.aborted) throw e
      await new Promise((r) => setTimeout(r, 700))
    } finally {
      g.done()
    }
  }
}

// 流式回包一行一个 `data: {...}`，这里只负责抽出来，怎么解析交给调用方
async function readSse(res, onData) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
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
      let j
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      onData(j)
    }
  }
}

// 会先思考的模型（V4 Flash 这类）把预算花在思考上时，content 会是空的。
// 只报「没有返回内容」等于把线索全扔了，这里按 finish_reason 说清到底为什么空。
// raw 是原始回包片段：模型名不存在、网关报错这类和服务端约定好的格式对不上时，
// 光看 finish_reason 是猜不出来的，得把原文带出来。
function noContent({ finish, reasoningChars = 0, maxTokens, raw } = {}) {
  const used = reasoningChars ? `，其中 ${reasoningChars} 字花在思考过程上` : ''
  const tail = raw ? `\n\n原始回包：${raw}` : ''
  if (finish === 'length')
    return `模型没有返回内容：输出撞到长度上限（max_tokens=${maxTokens ?? '?'}）${used}，把上限调大或让它少写点${tail}`
  if (finish === 'content_filter')
    return `模型没有返回内容：这次输出被判成敏感内容拦掉了，换个问法试试${tail}`
  if (finish === 'insufficient_system_resource')
    return `模型没有返回内容：服务端资源不足，等一会儿重试${tail}`
  if (reasoningChars)
    return `模型没有返回内容：只输出了思考过程${used}，没轮到正式回答，重试一次通常就好${tail}`
  return `模型没有返回内容：这个模型名可能不支持当前调用方式（比如不支持流式或 tools），换个模型试试${tail}`
}

// 回包可能很大（尤其带 tool_calls 的），只留开头一小段用于排错
function brief(v) {
  if (v == null) return ''
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 300 ? `${s.slice(0, 300)}…` : s
  } catch {
    return String(v)
  }
}


export function chat(messages, { cfg, temperature = 0.3, maxTokens = 3000, signal } = {}) {
  const mt = budgetOf(maxTokens, cfg)
  return request(
    cfg,
    { messages, temperature, max_tokens: mt, stream: false },
    { signal },
    async (res) => {
      const json = await res.json()
      const choice = json?.choices?.[0]
      const text = choice?.message?.content
      if (!text) {
        throw new Error(
          noContent({
            finish: choice?.finish_reason,
            reasoningChars: (choice?.message?.reasoning_content || '').length,
            maxTokens: mt,
            raw: brief(json?.error || json),
          }),
        )
      }
      return text
    },
  )
}

// 同一套接口的流式版本：边收边显示，长答案不用干等
export function chatStream(
  messages,
  { cfg, temperature = 0.3, maxTokens = 2000, onDelta, onThink, signal } = {},
) {
  let full = ''
  let finish = ''
  let reasoning = ''
  let sample = ''
  const mt = budgetOf(maxTokens, cfg)
  return request(
    cfg,
    { messages, temperature, max_tokens: mt, stream: true },
    { signal },
    async (res) => {
      await readSse(res, (j) => {
        if (!sample) sample = brief(j)
        const ch = j?.choices?.[0]
        if (ch?.finish_reason) finish = ch.finish_reason
        if (ch?.delta?.reasoning_content) {
          reasoning += ch.delta.reasoning_content
          onThink && onThink(ch.delta.reasoning_content, reasoning)
        }
        const delta = ch?.delta?.content || ''
        if (!delta) return
        full += delta
        onDelta && onDelta(delta, full)
      })
      if (!full)
        throw new Error(
          noContent({ finish, reasoningChars: reasoning.length, maxTokens: mt, raw: sample }),
        )
      return full
    },
  )
}

// 模型有时会包 ```json 或者前后加解释，这里只取中间那个对象
export function pickJson(text) {
  let t = String(text ?? '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  try {
    return JSON.parse(t)
  } catch {}
  // 模型常见手滑：对象 / 数组最后多一个逗号。修一下再试，别为这个让整轮白跑
  try {
    return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'))
  } catch {}
  const cut = t.length > 2000 ? '（多半是输出被长度上限截断了，少给点内容再试）' : ''
  throw new Error(`模型返回的不是合法 JSON${cut}，重试一次通常就好`)
}

// 设置页的连通性测试
export async function ping(cfg) {
  const text = await chat(
    [
      { role: 'system', content: '只回复 ok' },
      { role: 'user', content: 'ping' },
    ],
    { cfg, temperature: 0, maxTokens: 512 },
  )
  return text.trim()
}

// 带 tools 的流式请求：正文边收边显示，顺带把 tool_calls 拼起来
export function chatStreamTools(
  messages,
  { cfg, tools, toolChoice, temperature = 0.2, maxTokens = 2000, onDelta, onThink, signal } = {},
) {
  const mt = budgetOf(maxTokens, cfg)
  const body = { messages, temperature, max_tokens: mt, stream: true }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = toolChoice || 'auto'
  }
  const calls = []
  let full = ''
  let finish = ''
  let reasoning = ''
  let sample = ''
  return request(cfg, body, { signal }, async (res) => {
    await readSse(res, (j) => {
      if (!sample) sample = brief(j)
      const ch = j?.choices?.[0]
      if (ch?.finish_reason) finish = ch.finish_reason
      const delta = ch?.delta
      if (!delta) return
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content
        onThink && onThink(delta.reasoning_content, reasoning)
      }
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
    })
    const toolCalls = calls
      .filter(Boolean)
      .filter((x) => x.function.name)
      .map((x, i) => ({ ...x, id: x.id || `call_${Date.now().toString(36)}_${i}` }))
    // 一句话没给、工具也没调，这一轮就是空的：早点说清原因，别让 agent 白转到第 6 轮
    if (!full && !toolCalls.length)
      throw new Error(noContent({ finish, reasoningChars: reasoning.length, maxTokens: mt, raw: sample }))
    return { text: full, toolCalls, reasoning }
  }).catch((e) => {
    // 端点压根不认 tools / functions 时才值得退回预检索流程：只认 4xx 里明确提到 tools 的报错，
    // 别让「超时」「没返回内容」这种偶发错误把 agent 永久关掉
    if (e.status >= 400 && e.status < 500 && /tool|function/i.test(e.message)) e.noTools = true
    throw e
  })
}
