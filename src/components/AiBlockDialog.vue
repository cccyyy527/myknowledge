<script setup>
import { computed, ref, watch } from 'vue'
import { loadAI, isAiReady, AI_ACTIONS, rewriteBlock } from '../lib/ai.js'
import BlockView from './BlockView.vue'
import AiThink from './AiThink.vue'
import AiSpin from './AiSpin.vue'

const props = defineProps({
  open: Boolean,
  block: { type: Object, default: null },
  note: { type: Object, default: null },
  sectionTitle: { type: String, default: '' },
})
const emit = defineEmits(['close', 'apply'])

const cfg = ref(loadAI())
// 深度思考只影响这个面板的请求，不写回设置
const think = ref(loadAI().thinking === 'on')
const busy = ref('')
const msg = ref('')
const bad = ref(false)
const draft = ref(null)
const lastAction = ref('')
const ask = ref('')

// 连续对话：上一轮改出来的稿子会带给模型，它记得自己动过什么，可以接着改、也可以只回答
const thread = ref([])
const chat = ref([]) // 面板上的对话流：{ who: 'me'|'ai', text, live }
const noticed = ref(false) // 这轮是不是因为思考吃满额度被降级重跑过

const say = (t, isBad = false) => {
  msg.value = t
  bad.value = isBad
}

const pushChat = (m) => {
  chat.value = [...chat.value, m]
}

const stepChat = (t, live = false) => {
  const list = chat.value.slice()
  const i = list.length - 1
  if (i < 0 || list[i].who !== 'ai') return
  list[i] = { ...list[i], text: t, live }
  chat.value = list
}

const reset = () => {
  thread.value = []
  chat.value = []
  draft.value = null
  lastAction.value = ''
  ask.value = ''
  say('')
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    think.value = cfg.value.thinking === 'on'
    reset()
    if (!isAiReady(cfg.value)) say('还没配 API Key，先在顶栏 ✨ → 设置 里填一下', true)
  },
)

const ready = computed(() => isAiReady(cfg.value))

const ASK_ACT = { id: 'ask', label: '提问', target: '' }

// 预设按钮和自由输入走同一条路：都是在这条对话上再问一轮
const turn = async ({ act, text, question = '' }) => {
  if (!props.block || busy.value) return
  busy.value = act.id
  say('')
  noticed.value = false
  lastAction.value = act.id
  const before = draft.value
  const isAsk = act.id === 'ask'
  // 点按钮就以按钮为准（润色该替换就替换）；自由提问沿用这轮稿子的做法，别把原块冲掉
  const keepMode = isAsk ? before?.mode : act.mode
  const keepAct = isAsk ? before?.action || ASK_ACT : act
  pushChat({ who: 'me', text })
  pushChat({ who: 'ai', text: question ? '看一下这一块…' : `${act.label}中…`, live: true })
  try {
    const r = await rewriteBlock({
      action: act.id,
      ask: question,
      block: props.block,
      note: props.note,
      sectionTitle: props.sectionTitle,
      cfg: { ...cfg.value, thinking: think.value ? 'on' : 'off' },
      messages: thread.value,
      blocks: before?.blocks,
      mode: keepMode,
      onNoThinking: () => (noticed.value = true),
    })
    thread.value = r.messages || []
    draft.value = { action: keepAct, mode: r.mode, blocks: r.blocks }
    const head = r.say || `${r.mode === 'replace' ? '改写' : '补'}好了 ${r.blocks.length} 块。`
    stepChat(noticed.value ? `${head}（这次思考把额度吃光了，已自动关掉深度思考重跑）` : head)
  } catch (e) {
    stepChat(`出错了：${String(e.message || e)}`)
  } finally {
    busy.value = ''
  }
}

const run = (action) => turn({ act: action, text: action.label })

// 直接问这个块：模型自己判断是「回答后补块」还是「按你的要求改这一块」
const runAsk = () => {
  const q = ask.value.trim()
  if (!q) return
  ask.value = ''
  turn({ act: ASK_ACT, text: q, question: q })
}

const apply = () => {
  if (!draft.value) return
  emit('apply', { action: { ...draft.value.action, mode: draft.value.mode }, blocks: draft.value.blocks })
  emit('close')
}
</script>

<template>
  <div v-if="open" class="ai-mask" @click.self="emit('close')">
    <div class="ai-box">
      <div class="ai-head">
        <strong>AI 改写</strong>
        <button class="ai-x" @click="emit('close')">×</button>
      </div>

      <div class="ai-src">
        <span class="ai-src-label">{{ block?.type }}</span>
        <div class="ai-src-body"><BlockView v-if="block" :block="{ ...block, type: block.type }" /></div>
      </div>

      <div class="ai-acts wrap">
        <button
          v-for="a in AI_ACTIONS"
          :key="a.id"
          :disabled="!!busy || !ready"
          :class="{ on: lastAction === a.id }"
          :title="a.hint"
          @click="run(a)"
        >
          {{ busy === a.id ? '生成中…' : a.label }}
        </button>
      </div>

      <div v-if="chat.length" class="ai-chat">
        <div v-for="(m, i) in chat" :key="i" class="ai-turn" :class="m.who">
          <span class="ai-who">{{ m.who === 'me' ? '我' : 'AI' }}</span>
          <p class="ai-line" :class="{ live: m.live }">{{ m.text }}</p>
        </div>
        <div class="ai-chat-foot">
          <button class="ai-bulk-btn" :disabled="!!busy" @click="reset">重新开始</button>
        </div>
      </div>

      <div class="ai-ask">
        <textarea
          v-model="ask"
          rows="2"
          :disabled="!!busy || !ready"
          :placeholder="
            thread.length
              ? '接着上一轮说，它记得前面改过什么：再短一点 / 为什么这么改 / 补个和 CUPED 的对比'
              : '也可以直接问这一块，或提要求：为什么除的是 n-1 / 写短点 / 补个和 CUPED 的对比'
          "
          @keydown.ctrl.enter.prevent="runAsk"
        ></textarea>
        <button :disabled="!!busy || !ready || !ask.trim()" @click="runAsk">
          {{ busy === 'ask' ? '思考中…' : '提问 / 照做' }}
        </button>
      </div>

      <div class="ai-acts wrap">
        <AiSpin :active="!!busy" label="生成中" />
        <AiThink v-model="think" hint="让模型先想一段再答，复杂改写更准，但慢一些、也更费 token" />
      </div>

      <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

      <template v-if="draft">
        <p class="ai-hint">
          预览（{{ draft.blocks.length }} 块）→ 点「采用」才会写进笔记，
          <template v-if="draft.mode === 'insert'">会插到这一块后面</template>
          <template v-else>会替换现在这一块</template>
        </p>
        <div class="ai-preview">
          <BlockView v-for="b in draft.blocks" :key="b.id" :block="b" />
        </div>
        <div class="ai-acts">
          <button class="ai-primary" @click="apply">采用</button>
          <button @click="draft = null">放弃这版</button>
        </div>
      </template>
    </div>
  </div>
</template>
