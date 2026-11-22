<script setup>
import { computed, ref, watch } from 'vue'
import { loadAI, isAiReady, reviseNote, applyOps } from '../lib/ai.js'
import BlockView from './BlockView.vue'

const props = defineProps({
  open: Boolean,
  note: { type: Object, default: null },
})
const emit = defineEmits(['close', 'applied'])

const PRESETS = [
  '核心结论拆成 2-3 条，每条一句断言',
  '每个公式后面补一句「为什么是这个式子」',
  '把段落里藏着的东西抽成概念卡',
  '给这篇补 2 条高频问法',
  '找出重复的块，合并掉',
]

const cfg = ref(loadAI())
const instruction = ref('')
const busy = ref(false)
const msg = ref('')
const bad = ref(false)
const rows = ref([])
const titleHint = ref('')

const say = (t, isBad = false) => {
  msg.value = t
  bad.value = isBad
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    rows.value = []
    titleHint.value = ''
    say('')
    if (!isAiReady(cfg.value)) say('还没配 API Key，先在顶栏 ✨ → 设置 里填一下', true)
  },
)

const ready = computed(() => isAiReady(cfg.value))

// 改动和新增默认勾上，删除默认不勾 —— 抹内容得人手点一下
const decorate = (ops) =>
  ops.map((o) => ({ ...o, checked: o.op === 'replace' || o.op === 'add' }))

const run = async (preset) => {
  const ins = String(preset ?? instruction.value).trim()
  if (!ins || busy.value || !props.note) return
  busy.value = true
  rows.value = []
  titleHint.value = ''
  say('')
  try {
    const r = await reviseNote({ note: props.note, instruction: ins, cfg: cfg.value })
    titleHint.value = r.title
    rows.value = decorate(r.ops)
    if (!r.ops.length) say('模型没给出可用的改动，换个说法再试', true)
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = false
  }
}

const counts = computed(() => {
  const c = { replace: 0, add: 0, drop: 0 }
  for (const r of rows.value) if (r.op in c) c[r.op]++
  return c
})

const apply = () => {
  if (!props.note || !rows.value.length) return
  if (titleHint.value) props.note.title = titleHint.value
  applyOps(props.note, rows.value)
  rows.value = []
  emit('applied')
  emit('close')
}
</script>

<template>
  <div v-if="open" class="ai-mask" @click.self="emit('close')">
    <div class="ai-box">
      <div class="ai-head">
        <strong>整篇助手</strong>
        <button class="ai-x" @click="emit('close')">×</button>
      </div>

      <p class="ai-tip">
        说一句要怎么改，AI 把这篇当一份稿子重排。改动会先列出来（改 / 新 / 删），你勾哪些就写哪些。
        段落标题由程序按「核心结论 / 推导 / 高频问法 / 坑 / 待补」重新生成，你自己加的小节会被并回去。
      </p>

      <textarea
        v-model="instruction"
        class="ai-area"
        rows="3"
        placeholder="例：核心结论拆成 3 条断言；每个公式后面补一句直觉解释；把最后那段空话删掉"
      />

      <div class="ai-acts wrap">
        <button
          v-for="p in PRESETS"
          :key="p"
          class="chip-btn"
          :disabled="busy || !ready"
          @click="run(p)"
        >
          {{ p }}
        </button>
      </div>

      <div class="ai-acts">
        <button
          class="ai-primary"
          :disabled="busy || !ready || !instruction.trim()"
          @click="run()"
        >
          {{ busy ? '生成中…' : '✨ 生成改动' }}
        </button>
      </div>

      <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

      <template v-if="rows.length">
        <p class="ai-hint">
          共 {{ rows.length }} 块 —— 改 {{ counts.replace }} / 新 {{ counts.add }} / 删
          {{ counts.drop }}，勾上的才写进去。
          <template v-if="titleHint">标题会改成「{{ titleHint }}」。</template>
        </p>

        <div class="ai-preview ai-diff">
          <div v-for="(r, i) in rows" :key="i" class="df-row" :class="'df-' + r.op">
            <div class="df-tag">
              <template v-if="r.op === 'keep'">保留</template>
              <template v-else>
                <input v-model="r.checked" type="checkbox" />
                <span>{{ r.op === 'replace' ? '改' : r.op === 'add' ? '新' : '删' }}</span>
              </template>
            </div>
            <div class="df-body">
              <BlockView v-if="r.op === 'keep' || r.op === 'drop'" :block="r.block" expand />
              <template v-else-if="r.op === 'replace'">
                <div v-if="r.old" class="df-old">
                  <BlockView :block="r.old" expand />
                </div>
                <div class="df-new">
                  <BlockView :block="{ ...r.block, id: r.id + '-pv' }" expand />
                </div>
              </template>
              <BlockView v-else :block="{ ...r.block, id: 'df-add-' + i }" expand />
            </div>
          </div>
        </div>

        <div class="ai-acts">
          <button class="ai-primary" @click="apply">写入笔记</button>
          <button @click="rows = []">放弃</button>
        </div>
      </template>
    </div>
  </div>
</template>
