<script setup>
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { loadAI, isAiReady, askLibrary } from '../lib/ai.js'
import { libraryStats } from '../lib/retrieve.js'

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
  turns.value.push({ q, a: '', used: [], streaming: true, err: '', fallback: false })
  const turn = turns.value[turns.value.length - 1]
  busy.value = true
  scroll()

  ctrl = new AbortController()
  try {
    const r = await askLibrary({
      question: q,
      history,
      cfg: loadAI(),
      signal: ctrl.signal,
      onDelta: (_, full) => {
        turn.a = full
        scroll()
      },
    })
    turn.a = r.text
    turn.used = r.used
    turn.fallback = r.fallback
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
</script>

<template>
  <div class="ask">
    <p class="ai-tip">
      直接问知识库。AI 只在你的笔记里找答案，找不到就说没有。现在库里 {{ stats.notes }} 篇 /
      {{ stats.blocks }} 个知识块。
    </p>

    <div v-if="!turns.length" class="ask-sugs">
      <button v-for="s in SUGGEST" :key="s" class="ask-sug" @click="ask(s)">{{ s }}</button>
    </div>

    <div ref="box" class="ask-thread" @click="onThreadClick">
      <div v-for="(t, i) in turns" :key="i" class="ask-turn">
        <div class="ask-q">{{ t.q }}</div>
        <div class="ask-a">
          <p v-if="t.err" class="ai-msg bad">{{ t.err }}</p>
          <template v-else>
            <div class="ask-text" v-html="rich(t.a, t.used)"></div>
            <span v-if="t.streaming" class="ask-caret">▍</span>
            <p v-if="!t.streaming && t.fallback" class="ask-none">
              库里没找到直接相关的笔记，上面是按最近更新的几篇答的
            </p>
            <div v-if="!t.streaming && t.used.length" class="ask-src">
              <button v-for="(s, k) in t.used" :key="s.id" class="ask-chip" @click="jump(s.id)">
                <span class="ask-chip-n">{{ k + 1 }}</span>{{ s.title }}
              </button>
            </div>
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
