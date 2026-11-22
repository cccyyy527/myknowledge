<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { loadAI, isAiReady, askLibrary, OUTSIDE_MARK, SECTIONS } from '../lib/ai.js'
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

const emit = defineEmits(['close', 'setup'])
const router = useRouter()

const SUGGEST = [
  '库里关于方差缩减的坑有哪些？',
  'CUPED 和分层调整的区别是什么？',
  '我还有哪些没查清的地方？',
]

const input = ref('')
const turns = ref([])
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

const scroll = async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}

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
    streaming: true,
    err: '',
    fallback: false,
    strict: strict.value,
  })
  const turn = turns.value[turns.value.length - 1]
  busy.value = true
  scroll()

  ctrl = new AbortController()
  try {
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
  } catch (e) {
    if (e.name === 'AbortError') turn.a = turn.a || '（已停止）'
    else turn.err = String(e.message || e)
  } finally {
    turn.streaming = false
    busy.value = false
    ctrl = null
    scroll()
  }
}

const stop = () => ctrl && ctrl.abort()

const reset = () => {
  if (busy.value) return
  turns.value = []
  saving.value = null
}

const jump = (id) => {
  emit('close')
  router.push(`/n/${id}`)
}

const onThreadClick = (e) => {
  const el = e.target.closest && e.target.closest('.ask-cite')
  if (el) jump(el.dataset.note)
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 只支持粗体 / 行内代码 / [n] 引用，够用且不会被模型带进奇怪的 HTML
const rich = (text, used = []) => {
  if (!text) return ''
  let s = esc(text)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[(\d+)\]/g, (m, d) => {
    const n = Number(d)
    if (n < 1 || n > used.length) return m
    return `<button class="ask-cite" data-note="${used[n - 1].id}">${n}</button>`
  })
  return s
}

// 回答里出现「【库外】」时，后面那段是模型自己的知识，要单独标出来
const splitOutside = (text) => {
  const s = String(text || '')
  const i = s.indexOf(OUTSIDE_MARK)
  if (i < 0) return { inside: s, outside: '' }
  return { inside: s.slice(0, i).trim(), outside: s.slice(i + OUTSIDE_MARK.length).trim() }
}

/* ---------- 把一条回答存成笔记 ---------- */

const saving = ref(null) // { idx, mode:'new'|'exist', topicId, noteId, section, outside }

const groups = computed(() =>
  state.domains.map((d) => ({ domain: d, rows: flattenTopics(d.id, true) })),
)

// 写进已有笔记时按标题选，顺序和笔记里的段落一致
const savingTurn = computed(() => (saving.value ? turns.value[saving.value.idx] : null))

// 只列有笔记的分类，空的太多了没法选
const noteOptions = computed(() =>
  state.notes.map((n) => ({
    id: n.id,
    title: n.title,
    path: topicPath(n.topicId).map((t) => t.name).join(' / '),
  })),
)

// 预览用的块：问答卡留住问题和答法，[n] 的出处附在后面才查得到
const savingBlocks = computed(() => {
  const t = savingTurn.value
  if (!t || !saving.value) return []
  const { inside, outside } = splitOutside(t.a)
  const src = t.used.length
    ? '\n\n来源：' + t.used.map((s, i) => `[${i + 1}] ${s.title}`).join('　')
    : ''
  const out = [{ id: 'pv-qa', type: 'qa', question: t.q, answer: (inside || '（空）') + src }]
  if (saving.value.outside && outside) {
    out.push({
      id: 'pv-warn',
      type: 'callout',
      tone: 'warn',
      text: '下面这段是 AI 的外部知识，不是你笔记里的内容，存进来后自己核一遍再当结论用。',
    })
    let i = 0
    for (const para of outside.split(/\n{2,}/)) {
      const text = para.trim()
      if (text) out.push({ id: `pv-p${i++}`, type: 'paragraph', text })
    }
  }
  return out
})

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
    outside: false,
  }
}

const doSave = () => {
  const t = savingTurn.value
  const s = saving.value
  if (!t || !s) return

  const clean = savingBlocks.value.map((b) => {
    const { id, ...rest } = b
    return { id: newBlockId(), ...rest }
  })

  if (s.mode === 'exist') {
    const note = state.notes.find((n) => n.id === s.noteId)
    if (!note) return
    const sec = SECTIONS.find((x) => x.id === s.section) || SECTIONS[0]
    insertBlocks(note, sec.title, clean)
    touchNote(note)
    saving.value = null
    emit('close')
    router.push(`/n/${note.id}`)
    return
  }

  if (!s.topicId) return
  const note = createNote(s.topicId)
  note.title = t.q.length > 38 ? t.q.slice(0, 38) + '…' : t.q
  note.blocks = clean
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
        先在你的笔记里找答案。笔记里没有、AI 自己知道的那部分会单独标成「库外」。现在库里
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
                </div>

                <template v-if="saving.mode === 'new'">
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

                <template v-else>
                  <label class="ai-pick">
                    <span>写进</span>
                    <select v-model="saving.noteId">
                      <option v-for="o in noteOptions" :key="o.id" :value="o.id">
                        {{ o.title }}（{{ o.path }}）
                      </option>
                    </select>
                  </label>
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

                <label v-if="splitOutside(t.a).outside" class="ask-save-out">
                  <input type="checkbox" v-model="saving.outside" />
                  <span>也带上「库外」那段（AI 外推的，会标成待核对）</span>
                </label>
                <div class="ai-preview ask-save-pv">
                  <BlockView v-for="b in savingBlocks" :key="b.id" :block="b" expand />
                </div>
                <div class="ai-acts">
                  <button class="ai-primary" @click="doSave">
                    {{ saving.mode === 'exist' ? '写进这篇' : '写入新笔记' }}
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
