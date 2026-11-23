<script setup>
import { computed, ref, watch } from 'vue'
import { loadAI, isAiReady, AI_ACTIONS, rewriteBlock } from '../lib/ai.js'
import BlockView from './BlockView.vue'

const props = defineProps({
  open: Boolean,
  block: { type: Object, default: null },
  note: { type: Object, default: null },
  sectionTitle: { type: String, default: '' },
})
const emit = defineEmits(['close', 'apply'])

const cfg = ref(loadAI())
const busy = ref('')
const msg = ref('')
const bad = ref(false)
const draft = ref(null)
const lastAction = ref('')
const ask = ref('')

const say = (t, isBad = false) => {
  msg.value = t
  bad.value = isBad
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    draft.value = null
    lastAction.value = ''
    ask.value = ''
    say('')
    if (!isAiReady(cfg.value)) say('还没配 API Key，先在顶栏 ✨ → 设置 里填一下', true)
  },
)

const ready = computed(() => isAiReady(cfg.value))

const run = async (action) => {
  if (!props.block) return
  busy.value = action.id
  say('')
  draft.value = null
  lastAction.value = action.id
  try {
    const r = await rewriteBlock({
      action: action.id,
      block: props.block,
      note: props.note,
      sectionTitle: props.sectionTitle,
      cfg: cfg.value,
    })
    draft.value = { action, mode: r.mode, blocks: r.blocks }
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

// 直接问这个块：模型自己判断是「回答后补块」还是「按你的要求改这一块」
const runAsk = async () => {
  const q = ask.value.trim()
  if (!q || !props.block) return
  busy.value = 'ask'
  say('')
  draft.value = null
  lastAction.value = 'ask'
  try {
    const r = await rewriteBlock({
      action: 'ask',
      ask: q,
      block: props.block,
      note: props.note,
      sectionTitle: props.sectionTitle,
      cfg: cfg.value,
    })
    draft.value = { action: { id: 'ask', label: '提问', target: '' }, mode: r.mode, blocks: r.blocks }
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
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

      <div class="ai-ask">
        <textarea
          v-model="ask"
          rows="2"
          :disabled="!!busy || !ready"
          placeholder="也可以直接问这一块，或提要求：为什么除的是 n-1 / 写短点 / 补个和 CUPED 的对比"
          @keydown.ctrl.enter.prevent="runAsk"
        ></textarea>
        <button :disabled="!!busy || !ready || !ask.trim()" @click="runAsk">
          {{ busy === 'ask' ? '思考中…' : '提问 / 照做' }}
        </button>
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
          <button @click="draft = null">放弃</button>
        </div>
      </template>
    </div>
  </div>
</template>
