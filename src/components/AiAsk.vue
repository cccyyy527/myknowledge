<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { loadAI, isAiReady, askLibrary, askAgent, archiveAgent, fileAnswer, assembleBlocks, stripMark, SECTIONS } from '../lib/ai.js'
import { libraryStats } from '../lib/retrieve.js'
import {
  state,
  createNote,
  newBlockId,
  flattenTopics,
  topicPath,
  insertBlocks,
  touchNote,
} from '../lib/store.js'
import BlockView from './BlockView.vue'
import { normTitle } from '../lib/links.js'

const emit = defineEmits(['close', 'setup'])
const router = useRouter()

const SUGGEST = [
  '库里关于方差缩减的坑有哪些？',
  'CUPED 和分层调整的区别是什么？',
  '我还有哪些没查清的地方？',
]

// 对话记录落 localStorage：关掉面板、刷新页面再打开，模型还记得刚才聊过什么、读过哪几块
const LOG_KEY = 'myknowledge.asklog'
const LOG_MAX = 10

const loadLog = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.slice(-LOG_MAX).map((t) => ({ ...t, streaming: false, trace: [] }))
  } catch {
    return []
  }
}

const input = ref('')
const turns = ref(loadLog())
const busy = ref(false)
const box = ref(null)
let ctrl = null

// 面试前怕被 AI 的通用知识带偏，就锁死只查笔记
const STRICT_KEY = 'myknowledge.askStrict'
const strict = ref(localStorage.getItem(STRICT_KEY) === '1')
watch(strict, (v) => {
  try {
    localStorage.setItem(STRICT_KEY, v ? '1' : '0')
  } catch {}
})

const ready = computed(() => isAiReady(loadAI()))
const stats = computed(() => libraryStats())

// 端点不一定支持 tools（DeepSeek 支持，自建反代常常不支持）：
// 试崩一次就记住，后面直接走老的预检索流程，别每问一次都白等一轮
const AGENT_KEY = 'myknowledge.agent'
const agentOk = ref(localStorage.getItem(AGENT_KEY) !== '0')
const turnOffAgent = () => {
  agentOk.value = false
  try {
    localStorage.setItem(AGENT_KEY, '0')
  } catch {}
}

const scroll = async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}

// messages 里有工具回包，体积能到几百 KB，超配额就逐级瘦身
let logTimer = 0
const capContent = (list, n) =>
  (list || []).map((m) =>
    typeof m.content === 'string' && m.content.length > n
      ? { ...m, content: m.content.slice(0, n) + '\n…（已截断）' }
      : m,
  )

const writeLog = (list) => {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list))
    return
  } catch {}
  try {
    localStorage.setItem(
      LOG_KEY,
      JSON.stringify(list.map((t) => ({ ...t, messages: capContent(t.messages, 4000) }))),
    )
    return
  } catch {}
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.map((t) => ({ ...t, messages: null }))))
  } catch {}
}

const saveLog = () => {
  clearTimeout(logTimer)
  logTimer = setTimeout(() => {
    writeLog(
      turns.value.slice(-LOG_MAX).map((t) => ({
        q: t.q,
        a: t.a,
        used: t.used || [],
        strict: t.strict,
        fallback: t.fallback,
        err: t.err || '',
        messages: t.messages || null,
        at: t.at || 0,
      })),
    )
  }, 500)
}

const clearLog = () => {
  clearTimeout(logTimer)
  try {
    localStorage.removeItem(LOG_KEY)
  } catch {}
}

onMounted(scroll)

const ask = async (preset) => {
  const q = String(preset ?? input.value).trim()
  if (!q || busy.value) return
  if (!ready.value) return emit('setup')

  // 只带最近几轮，问答本身比历史更重要
  const history = []
  for (const t of turns.value.slice(-3)) {
    history.push({ role: 'user', content: t.q })
    if (t.a) history.push({ role: 'assistant', content: t.a })
  }

  input.value = ''
  turns.value.push({
    q,
    a: '',
    used: [],
    trace: [],
    streaming: true,
    err: '',
    fallback: false,
    strict: strict.value,
    messages: null,
    at: Date.now(),
  })
  const turn = turns.value[turns.value.length - 1]
  busy.value = true
  scroll()

  ctrl = new AbortController()
  let done = false
  try {
    if (agentOk.value) {
      try {
        const r = await askAgent({
          question: q,
          history,
          cfg: loadAI(),
          strict: strict.value,
          signal: ctrl.signal,
          onDelta: (_, full) => {
            turn.a = full
            scroll()
          },
          onTrace: (line) => {
            turn.trace.push(line)
            // 工具轮里模型可能先嘀咕两句，那不是答案；等它查到东西再重新开始攒
            turn.a = ''
            scroll()
          },
        })
        turn.a = r.text
        turn.used = r.refs
        turn.messages = r.messages
        done = true
      } catch (e) {
        if (e.name === 'AbortError' || !e.noTools) throw e
        turnOffAgent()
        turn.trace = []
        turn.a = ''
      }
    }

    if (!done) {
      const r = await askLibrary({
        question: q,
        history,
        cfg: loadAI(),
        strict: strict.value,
        signal: ctrl.signal,
        onDelta: (_, full) => {
          turn.a = full
          scroll()
        },
      })
      turn.a = r.text
      turn.used = r.used
      turn.fallback = r.fallback
      turn.strict = r.strict
    }
  } catch (e) {
    if (e.name === 'AbortError') turn.a = turn.a || '（已停止）'
    else turn.err = String(e.message || e)
  } finally {
    turn.streaming = false
    busy.value = false
    ctrl = null
    saveLog()
    scroll()
  }
}

const stop = () => ctrl && ctrl.abort()

const reset = () => {
  if (busy.value) return
  turns.value = []
  saving.value = null
  clearLog()
}

const jump = (id) => {
  emit('close')
  router.push(`/n/${id}`)
}

const onThreadClick = (e) => {
  const el = e.target.closest && e.target.closest('.ask-cite, .ask-link')
  if (el && el.dataset.note) jump(el.dataset.note)
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 只支持粗体 / 行内代码 / [n] 引用 / [[笔记标题]]，够用且不会被模型带进奇怪的 HTML
const rich = (text, used = []) => {
  if (!text) return ''
  // [[ ]] 先换成占位符：标题原样比较（esc 之后对不上），也别让 [n] 规则把它吃了
  const links = []
  let raw = stripMark(text).replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (_m, t) => {
    links.push(t.trim())
    return `\u0000${links.length - 1}\u0000`
  })
  let s = esc(raw)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[(\d+)\]/g, (m, d) => {
    const n = Number(d)
    if (n < 1 || n > used.length) return m
    return `<button class="ask-cite" data-note="${used[n - 1].id}">${n}</button>`
  })
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const t = links[Number(i)] || ''
    const hit = state.notes.find((n) => normTitle(n.title) === normTitle(t))
    return hit
      ? `<button class="ask-link" data-note="${hit.id}" title="跳到《${esc(hit.title)}》">${esc(t)}</button>`
      : `<span class="ask-link missing" title="库里还没有这篇">${esc(t)}</span>`
  })
}

// 回答里出现「【库外】」时，后面那段是模型自己的知识，要单独标出来。
// 这个标记只给这里用：切完再抹一遍，正文里永远不会露出这几个字
const OUT_RE = /【\s*库外(?:补充)?\s*】/
const splitOutside = (text) => {
  const s = String(text || '')
  const m = s.match(OUT_RE)
  if (!m) return { inside: stripMark(s), outside: '' }
  return {
    inside: stripMark(s.slice(0, m.index)),
    outside: stripMark(s.slice(m.index + m[0].length)),
  }
}

/* ---------- 把一条回答存成笔记 ---------- */

const saving = ref(null) // { idx, mode, topicId, noteId, section, outside, title, blocks, reason, analyzing, err }

const groups = computed(() =>
  state.domains.map((d) => ({ domain: d, rows: flattenTopics(d.id, true) })),
)

// 写进已有笔记时按标题选，顺序和笔记里的段落一致
const savingTurn = computed(() => (saving.value ? turns.value[saving.value.idx] : null))

// 拿块的首句当标签，用来告诉用户「插在哪块后面」
function labelOf(noteId, blockId) {
  const note = state.notes.find((n) => n.id === noteId)
  const b = note?.blocks?.find((x) => x.id === blockId)
  if (!b) return ''
  const raw = b.text || b.term || b.question || b.items?.[0] || b.latex || ''
  const t = stripMark(String(raw)).replace(/\s+/g, ' ').trim()
  return t.length > 18 ? t.slice(0, 18) + '…' : t
}

// 改已有块时按条目渲染「旧 → 新」对照
const editPlan = computed(() => {
  const s = saving.value
  if (!s || s.mode !== 'edit' || !s.edits?.length) return []
  return s.edits.map((e, i) => ({
    key: `ed${i}`,
    op: e.op,
    why: e.why,
    before: e.before,
    after: e.after,
    afterTitle: e.op === 'insert' ? labelOf(s.noteId, e.afterBlockId) : '',
  }))
})

const OP_TEXT = { replace: '改写', remove: '删除', insert: '就地插入' }

// 只列有笔记的分类，空的太多了没法选
const noteOptions = computed(() =>
  state.notes.map((n) => ({
    id: n.id,
    title: n.title,
    path: topicPath(n.topicId).map((t) => t.name).join(' / '),
  })),
)

// 改已有块时预览头里要显示改的是哪一篇
const editingNote = computed(() =>
  saving.value ? state.notes.find((n) => n.id === saving.value.noteId) : null,
)

const blankTitle = (q) => (q.length > 38 ? q.slice(0, 38) + '…' : q)

// AI 没判断出来时的兜底：整条回答就是一张问答卡
const plainBlocks = computed(() => {
  const t = savingTurn.value
  if (!t) return []
  const inside = stripMark(t.a)
  const src = t.used.length
    ? '\n\n来源：' + t.used.map((s, i) => `[${i + 1}] ${s.title}`).join('　')
    : ''
  const refs = t.used.map((s) => ({ id: s.id, title: s.title }))
  return [{ id: 'pv-qa', type: 'qa', question: t.q, answer: (inside || '（空）') + src, refs }]
})

// [n] 落到哪个块上，就把 refs 记在那个块里，渲染时才能点
const REF_RE = /\[\d+\]/
const attachRefs = (blocks, refs) => {
  if (!refs.length) return blocks
  const fields = ['text', 'detail', 'answer', 'cause', 'avoid', 'term']
  return blocks.map((b) => {
    const hit =
      fields.some((k) => REF_RE.test(b[k] || '')) || (b.items || []).some((s) => REF_RE.test(s))
    return hit ? { ...b, refs } : b
  })
}

// 预览：有 AI 分块就按段落排，没有就退回一张问答卡
const savingBlocks = computed(() => {
  const s = saving.value
  if (!s) return []
  const refs = (savingTurn.value?.used || []).map((x) => ({ id: x.id, title: x.title }))
  return s.blocks?.length ? groupBySection(attachRefs(s.blocks, refs)) : plainBlocks.value
})

// 预览里的引用 chip：开新标签看原文，别把面板连同草稿一起关掉
const openCite = (id) => window.open(`${location.pathname}#/n/${id}`, '_blank')

// 只给真有内容的段落加标题，预览里不出现空小节
function groupBySection(blocks) {
  const out = []
  for (const sec of SECTIONS) {
    const items = blocks.filter((b) => (b.section || 'core') === sec.id)
    if (!items.length) continue
    out.push({ id: 'pv-h-' + sec.id, type: 'heading', level: 2, text: sec.title })
    out.push(...items)
  }
  return out
}

const analyze = async (idx) => {
  const t = turns.value[idx]
  const s = saving.value
  if (!t || !s || s.analyzing) return
  s.analyzing = true
  s.err = ''
  s.trace = []
  try {
    let r = null
    // 沿着问答那轮的会话往下问：模型还记着刚查过哪些笔记、哪篇是空的
    if (t.messages?.length && agentOk.value) {
      try {
        const out = await archiveAgent({
          messages: t.messages,
          refs: t.used.map((x) => ({ id: x.id, title: x.title })),
          cfg: loadAI(),
          onTrace: (line) => {
            if (saving.value !== s) return
            s.trace.push(line)
            scroll()
          },
        })
        if (out.proposal) {
          t.messages = out.messages
          r = out.proposal
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e
        if (e.noTools) turnOffAgent()
        // 会话续不上就退回一次性归档判断，别让用户看到错误
      }
    }
    if (!r) {
      r = await fileAnswer({
        question: t.q,
        answer: stripMark(t.a),
        used: t.used,
        cfg: loadAI(),
      })
    }
    if (saving.value !== s) return
    s.reason = stripMark(r.reason)
    if (r.target === 'edit') {
      s.mode = 'edit'
      s.noteId = r.noteId
      s.blocks = null
      s.edits = r.edits || []
      s.plan = r.blocks || []
      s.skipped = r.skipped || []
      return
    }
    s.blocks = r.blocks
    s.mode = r.target
    s.section = r.section
    if (r.target === 'exist') s.noteId = r.noteId
    else {
      s.topicId = r.topicId
      // 模型给的标题更像笔记名，但用户改过的就别覆盖
      if (r.title && !s.touchedTitle) s.title = stripMark(r.title)
    }
  } catch (e) {
    if (saving.value === s) s.err = String(e.message || e)
  } finally {
    if (saving.value === s) s.analyzing = false
  }
}

const openSave = (idx) => {
  const t = turns.value[idx]
  const srcNote = t.used[0] && state.notes.find((n) => n.id === t.used[0].id)
  const anyTopic = flattenTopics(state.domains[0]?.id, true)[0]?.topic?.id || ''
  saving.value = {
    idx,
    mode: 'new',
    topicId: srcNote?.topicId || anyTopic,
    noteId: srcNote?.id || state.notes[0]?.id || '',
    section: 'qa',
    title: blankTitle(t.q),
    blocks: null,
    edits: [],
    plan: null,
    skipped: [],
    reason: '',
    analyzing: false,
    err: '',
    trace: [],
    touchedTitle: false,
  }
  if (ready.value) analyze(idx)
}

const doSave = () => {
  const t = savingTurn.value
  const s = saving.value
  if (!t || !s || s.analyzing) return

  const refs = t.used.map((x) => ({ id: x.id, title: x.title }))
  const ai = s.blocks?.length ? attachRefs(s.blocks, refs) : null
  const body = ai || plainBlocks.value

  const clean = (list) =>
    list.map((b) => {
      const { id, ...rest } = b
      for (const k of Object.keys(rest)) {
        if (typeof rest[k] === 'string') rest[k] = stripMark(rest[k])
        else if (Array.isArray(rest[k])) rest[k] = rest[k].map((x) => (typeof x === 'string' ? stripMark(x) : x))
      }
      return { id: newBlockId(), ...rest }
    })

  if (s.mode === 'edit') {
    const note = state.notes.find((n) => n.id === s.noteId)
    if (!note || !s.plan?.length) return
    note.blocks = s.plan
    touchNote(note)
    saving.value = null
    emit('close')
    router.push(`/n/${note.id}`)
    return
  }

  if (s.mode === 'exist') {
    const note = state.notes.find((n) => n.id === s.noteId)
    if (!note) return
    if (ai) {
      // AI 已经把每块归好段了，按段落分别拼进去
      for (const sec of SECTIONS) {
        const items = clean(ai.filter((b) => (b.section || 'core') === sec.id))
        if (items.length) insertBlocks(note, sec.title, items)
      }
    } else {
      const sec = SECTIONS.find((x) => x.id === s.section) || SECTIONS[0]
      insertBlocks(note, sec.title, clean(body))
    }
    touchNote(note)
    saving.value = null
    emit('close')
    router.push(`/n/${note.id}`)
    return
  }

  if (!s.topicId) return
  const note = createNote(s.topicId)
  note.title = (s.title || '').trim() || blankTitle(t.q)
  note.blocks = clean(ai ? assembleBlocks(ai) : body)
  saving.value = null
  emit('close')
  router.push(`/n/${note.id}`)
}

const pathOf = (id) => (id ? topicPath(id).map((t) => t.name).join(' / ') : '')
</script>

<template>
  <div class="ask">
    <div class="ask-bar">
      <p class="ai-tip">
        先在你的笔记里找答案。笔记里没有、AI 自己知道的那部分会单独放在「AI 补充」里。现在库里
        {{ stats.notes }} 篇 / {{ stats.blocks }} 个知识块。
      </p>
      <label class="ask-strict" :class="{ on: strict }">
        <input type="checkbox" v-model="strict" />
        <span>只查我的笔记</span>
      </label>
    </div>

    <div v-if="!turns.length" class="ask-sugs">
      <button v-for="s in SUGGEST" :key="s" class="ask-sug" @click="ask(s)">{{ s }}</button>
    </div>

    <div ref="box" class="ask-thread" @click="onThreadClick">
      <div v-for="(t, i) in turns" :key="i" class="ask-turn">
        <div class="ask-q">{{ t.q }}</div>
        <div class="ask-a">
          <p v-if="t.err" class="ai-msg bad">{{ t.err }}</p>
          <template v-else>
            <div v-if="t.trace && t.trace.length" class="ask-trace">
              <span v-for="(g, k) in t.trace" :key="k" class="ask-trace-i">{{ g }}</span>
            </div>
            <p v-if="t.streaming && !t.a" class="ask-none">正在翻你的笔记…</p>
            <div class="ask-text" v-html="rich(splitOutside(t.a).inside, t.used)"></div>
            <div v-if="splitOutside(t.a).outside" class="ask-outside">
              <div class="ask-outside-tip">AI 的外部知识，不是你笔记里的内容</div>
              <div class="ask-text" v-html="rich(splitOutside(t.a).outside, [])"></div>
            </div>
            <span v-if="t.streaming" class="ask-caret">▍</span>
            <p v-if="!t.streaming && t.fallback" class="ask-none">
              库里没找到直接相关的笔记，上面是按最近更新的几篇答的
            </p>
            <p v-if="!t.streaming && t.strict" class="ask-none">只查了你的笔记</p>
            <div v-if="!t.streaming && t.used.length" class="ask-src">
              <button v-for="(s, k) in t.used" :key="s.id" class="ask-chip" @click="jump(s.id)">
                <span class="ask-chip-n">{{ k + 1 }}</span>{{ s.title }}
              </button>
            </div>
            <template v-if="!t.streaming">
              <button v-if="!saving || saving.idx !== i" class="ask-save" @click="openSave(i)">
                ＋ 存成笔记
              </button>

              <div v-else class="ask-save-box">
                <div class="ask-save-head">
                  <span>存成笔记</span>
                  <button class="ask-save-x" title="取消" @click="saving = null">×</button>
                </div>

                <p v-if="saving.analyzing" class="ask-save-why">✨ AI 正在判断该新建还是追加、内容怎么分块…</p>
                <div v-if="saving.trace && saving.trace.length" class="ask-trace ask-trace-save">
                  <span v-for="(g, k) in saving.trace" :key="k" class="ask-trace-i">{{ g }}</span>
                </div>
                <template v-else-if="saving.reason || saving.err">
                  <p v-if="saving.err" class="ai-msg bad">{{ saving.err }}</p>
                  <p v-else class="ask-save-why">✨ {{ saving.reason }}</p>
                  <button class="ask-save-retry" @click="analyze(saving.idx)">↻ 让 AI 重新判断</button>
                </template>

                <div class="ask-save-mode">
                  <button :class="{ on: saving.mode === 'new' }" @click="saving.mode = 'new'">
                    新建一篇
                  </button>
                  <button
                    :class="{ on: saving.mode === 'exist' }"
                    :disabled="!noteOptions.length"
                    @click="saving.mode = 'exist'"
                  >
                    写进已有笔记
                  </button>
                  <button
                    v-if="saving.plan"
                    :class="{ on: saving.mode === 'edit' }"
                    @click="saving.mode = 'edit'"
                  >
                    改已有内容
                  </button>
                </div>

                <template v-if="saving.mode === 'edit'">
                  <p class="ask-save-path">
                    改《{{ editingNote?.title || '这篇' }}》{{ editPlan.length }} 处<span
                      v-if="saving.skipped?.length"
                    >
                      ，另有 {{ saving.skipped.length }} 处对不上被丢掉</span
                    >
                  </p>
                  <div class="ask-edits">
                    <div v-for="e in editPlan" :key="e.key" class="ask-edit">
                      <div class="ask-edit-head">
                        <span class="ask-edit-op" :class="e.op">{{ OP_TEXT[e.op] || e.op }}</span>
                        <span v-if="e.afterTitle" class="ask-edit-at">插在「{{ e.afterTitle }}」后面</span>
                        <span v-if="e.why" class="ask-edit-why">{{ e.why }}</span>
                      </div>
                      <div v-if="e.before" class="ask-edit-before" :class="{ gone: e.op === 'remove' }">
                        <BlockView :block="e.before" expand />
                      </div>
                      <div v-if="e.after" class="ask-edit-after">
                        <BlockView :block="e.after" expand @open-note="openCite" />
                      </div>
                    </div>
                  </div>
                </template>

                <template v-if="saving.mode === 'new'">
                  <label class="ai-pick">
                    <span>标题</span>
                    <input
                      v-model.trim="saving.title"
                      class="ask-save-title"
                      placeholder="这篇笔记叫什么"
                      @input="saving.touchedTitle = true"
                    />
                  </label>
                  <label class="ai-pick">
                    <span>落到</span>
                    <select v-model="saving.topicId">
                      <optgroup v-for="g in groups" :key="g.domain.id" :label="g.domain.name">
                        <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
                          {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
                        </option>
                      </optgroup>
                    </select>
                  </label>
                  <p class="ask-save-path">{{ pathOf(saving.topicId) }}</p>
                </template>

                <template v-else-if="saving.mode === 'exist'">
                  <label class="ai-pick">
                    <span>写进</span>
                    <select v-model="saving.noteId">
                      <option v-for="o in noteOptions" :key="o.id" :value="o.id">
                        {{ o.title }}（{{ o.path }}）
                      </option>
                    </select>
                  </label>
                  <template v-if="!saving.blocks?.length">
                    <label class="ai-pick">
                      <span>加到这段</span>
                      <select v-model="saving.section">
                        <option v-for="s in SECTIONS" :key="s.id" :value="s.id">{{ s.title }}</option>
                      </select>
                    </label>
                    <p class="ask-save-path">
                      会拼到「{{ (SECTIONS.find((s) => s.id === saving.section) || SECTIONS[0]).title }}」这一段末尾
                    </p>
                  </template>
                  <p v-else class="ask-save-path">每块按内容自己找段落，插到对应小节末尾</p>
                </template>

                <div v-if="saving.mode !== 'edit'" class="ai-preview ask-save-pv">
                  <BlockView
                    v-for="b in savingBlocks"
                    :key="b.id"
                    :block="b"
                    expand
                    @open-note="openCite"
                  />
                </div>
                <div class="ai-acts">
                  <button
                    class="ai-primary"
                    :disabled="saving.analyzing || (saving.mode === 'edit' && !editPlan.length)"
                    @click="doSave"
                  >
                    {{ saving.mode === 'edit' ? '应用改动' : saving.mode === 'exist' ? '写进这篇' : '写入新笔记' }}
                  </button>
                  <button @click="saving = null">取消</button>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>

    <div class="ask-input">
      <textarea
        v-model="input"
        class="ai-area"
        rows="2"
        placeholder="例：CUPED 的协变量为什么必须是实验前的？Enter 发送，Shift+Enter 换行"
        @keydown.enter.exact.prevent="ask()"
      />
      <div class="ai-acts">
        <button class="ai-primary" :disabled="busy || !input.trim()" @click="ask()">
          {{ busy ? '回答中…' : '提问' }}
        </button>
        <button v-if="busy" @click="stop">停止</button>
        <button v-if="turns.length && !busy" @click="reset">新会话</button>
        <span v-if="!ready" class="muted">还没填 Key，去「设置」</span>
      </div>
    </div>
  </div>
</template>
