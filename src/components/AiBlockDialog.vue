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
    const blocks = await rewriteBlock({
      action: action.id,
      block: props.block,
      note: props.note,
      sectionTitle: props.sectionTitle,
      cfg: cfg.value,
    })
    draft.value = { action, blocks }
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const apply = () => {
  if (!draft.value) return
  emit('apply', { action: draft.value.action, blocks: draft.value.blocks })
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

      <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

      <template v-if="draft">
        <p class="ai-hint">
          预览（{{ draft.blocks.length }} 块）→ 点「采用」才会写进笔记
          <template v-if="draft.action.mode === 'insert'">
            ，会插到「{{ draft.action.target }}」这一段
          </template>
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
