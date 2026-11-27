// 传输层：配置读写、请求超时与重试、SSE 解析、模型返回的 JSON 容错



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
        body: JSON.stringify({ model: c.model, ...body }),
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

export function chat(messages, { cfg, temperature = 0.3, maxTokens = 3000, signal } = {}) {
  return request(
    cfg,
    { messages, temperature, max_tokens: maxTokens, stream: false },
    { signal },
    async (res) => {
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content
      if (!text) throw new Error('模型没有返回内容')
      return text
    },
  )
}

// 同一套接口的流式版本：边收边显示，长答案不用干等
export function chatStream(
  messages,
  { cfg, temperature = 0.3, maxTokens = 2000, onDelta, signal } = {},
) {
  let full = ''
  return request(
    cfg,
    { messages, temperature, max_tokens: maxTokens, stream: true },
    { signal },
    async (res) => {
      await readSse(res, (j) => {
        const delta = j?.choices?.[0]?.delta?.content || ''
        if (!delta) return
        full += delta
        onDelta && onDelta(delta, full)
      })
      if (!full) throw new Error('模型没有返回内容')
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
    { cfg, temperature: 0, maxTokens: 8 },
  )
  return text.trim()
}

// 带 tools 的流式请求：正文边收边显示，顺带把 tool_calls 拼起来
export function chatStreamTools(
  messages,
  { cfg, tools, toolChoice, temperature = 0.2, maxTokens = 2000, onDelta, signal } = {},
) {
  const body = { messages, temperature, max_tokens: maxTokens, stream: true }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = toolChoice || 'auto'
  }
  const calls = []
  let full = ''
  return request(cfg, body, { signal }, async (res) => {
    await readSse(res, (j) => {
      const delta = j?.choices?.[0]?.delta
      if (!delta) return
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
    return { text: full, toolCalls }
  }).catch((e) => {
    // 端点压根不认 tools / functions 时才值得退回预检索流程：只认 4xx 里明确提到 tools 的报错，
    // 别让「超时」「没返回内容」这种偶发错误把 agent 永久关掉
    if (e.status >= 400 && e.status < 500 && /tool|function/i.test(e.message)) e.noTools = true
    throw e
  })
}
