<script setup>
import { computed, ref, watch } from 'vue'
import { loadAI, isAiReady, reviseNote, applyOps, diagnose, SECTIONS } from '../lib/ai.js'
import BlockView from './BlockView.vue'
import AiThink from './AiThink.vue'
import AiSpin from './AiSpin.vue'

const props = defineProps({
  open: Boolean,
  note: { type: Object, default: null },
})
const emit = defineEmits(['close', 'applied'])

const PRESETS = [
  '梳理结构：放错段的块挪回去，重复的合并掉',
  '核心结论拆成 2-3 条，每条一句断言',
  '每个公式后面补一句「为什么是这个式子」',
  '把段落里藏着的东西抽成概念卡',
  '给这篇补 2 条高频问法',
  '找出重复的块，合并掉',
]

const cfg = ref(loadAI())
// 整篇重排是最该开思考的场景：要判断哪块放错段、哪些重复，慢一点换准一点
const think = ref(false)
const instruction = ref('')
const busy = ref(false)
const msg = ref('')
const bad = ref(false)
const rows = ref([])
const titleHint = ref('')
const advice = ref('')
const related = ref([])

const say = (t, isBad = false) => {
  msg.value = t
  bad.value = isBad
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    think.value = cfg.value.thinking === 'on'
    rows.value = []
    titleHint.value = ''
    advice.value = ''
    related.value = []
    view.value = 'preview'
    showKeep.value = false
    say('')
    if (!isAiReady(cfg.value)) say('还没配 API Key，先在顶栏 ✨ → 设置 里填一下', true)
  },
)

const ready = computed(() => isAiReady(cfg.value))

// 整篇助手只按固定五段重排：自定义小节会被并回去，先提醒一句
const customSecs = computed(() => {
  const known = new Set(SECTIONS.map((s) => s.title))
  return (props.note?.blocks || [])
    .filter((b) => b.type === 'heading' && b.level === 2 && b.text && !known.has(b.text))
    .map((b) => b.text)
})

// 结构诊断：面板上先给用户看一遍「哪里歪了」，也顺便解释 AI 动手的依据
const diag = computed(() => (props.note ? diagnose(props.note) : null))

// 改动和新增默认勾上，删除默认不勾 —— 抹内容得人手点一下
const decorate = (ops) =>
  ops.map((o) => ({ ...o, checked: o.op === 'replace' || o.op === 'add' || o.op === 'move' }))

const run = async (preset) => {
  const ins = String(preset ?? instruction.value).trim()
  if (!ins || busy.value || !props.note) return
  busy.value = true
  rows.value = []
  titleHint.value = ''
  advice.value = ''
  related.value = []
  view.value = 'preview'
  say('')
  try {
    const r = await reviseNote({
      note: props.note,
      instruction: ins,
      cfg: { ...cfg.value, thinking: think.value ? 'on' : 'off' },
    })
    titleHint.value = r.title
    advice.value = r.advice || ''
    related.value = r.related || []
    rows.value = decorate(r.ops)
    if (!r.ops.length) say('模型没给出可用的改动，换个说法再试', true)
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = false
  }
}

const counts = computed(() => {
  const c = { keep: 0, move: 0, replace: 0, add: 0, drop: 0 }
  for (const r of rows.value) if (r.op in c) c[r.op]++
  return c
})

// 未改动的块默认折起来：一笔记几十块，全铺开就看不见真正改了哪几处
const showKeep = ref(false)
const visibleRows = computed(() => (showKeep.value ? rows.value : rows.value.filter((r) => r.op !== 'keep')))

// 可以勾的只有挪/改/新/删；keep 是原样留住的块，没有勾选框
const pickable = computed(() => rows.value.filter((r) => r.op !== 'keep'))
const unchecked = computed(() => pickable.value.filter((r) => !r.checked).length)
const setAll = (v) => pickable.value.forEach((r) => (r.checked = v))

const secName = (id) => (SECTIONS.find((s) => s.id === id) || SECTIONS[0]).title

/* ---------- 预览成品：左原文右改后 ---------- */

const view = ref('preview')

// 深拷贝一份跑 applyOps，拿到的就是「按现在勾选写进去」的样子。
// 顺带要 marks（哪几块动了）和 dropped（哪几块被删了），否则预览只是一堆看不出差别的字
const preview = computed(() => {
  if (!props.note || !rows.value.length) return null
  const draft = JSON.parse(JSON.stringify({ title: props.note.title, blocks: props.note.blocks }))
  const { marks, dropped } = applyOps(
    draft,
    rows.value.map((r) => ({ ...r })),
  )
  return { blocks: draft.blocks || [], marks, dropped }
})

const pvStat = computed(() => {
  const p = preview.value
  if (!p) return { src: 0, total: 0, secs: 0, changed: 0, dropped: 0 }
  const secs = p.blocks.filter((b) => b.type === 'heading' && b.level === 2).length
  const srcSecs = (props.note?.blocks || []).filter((b) => b.type === 'heading' && b.level === 2).length
  return {
    src: (props.note?.blocks || []).length - srcSecs,
    total: p.blocks.length - secs,
    secs,
    changed: p.marks.size,
    dropped: p.dropped.size,
  }
})

const markOf = (id) => (preview.value && preview.value.marks.get(id)) || ''

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
        说一句要怎么改，AI 把这篇当一份稿子重排。改动会先列出来（挪 / 改 / 新 / 删），你勾哪些就写哪些；
        懒得逐个勾就点「全部接受」（删除默认不勾，抹内容得自己点一下）。
        段落标题由程序按「核心结论 / 推导 / 高频问法 / 坑 / 待补」重新生成，你自己加的小节会被并回去。
      </p>

      <div v-if="diag && diag.total" class="ai-struct">
        <span v-for="s in diag.sections" :key="s.id" class="st-seg" :class="{ empty: !s.count }">
          {{ s.title }}<i class="st-n">{{ s.count }}</i>
        </span>
      </div>
      <p v-if="diag && diag.flags.length" class="ai-tip st-flag">
        {{ diag.flags.slice(0, 2).join('；') }}<template v-if="diag.flags.length > 2"
          >；另有 {{ diag.flags.length - 2 }} 处</template
        >
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

      <p v-if="customSecs.length" class="ai-msg">
        这篇有自己起的小节（{{ customSecs.join('、') }}）。整篇助手只按固定五段重排，
        那几个小节的标题会被并回去 —— 里面的块不会丢，只是归到相邻的一段。
      </p>

      <div class="ai-acts">
        <button
          class="ai-primary"
          :disabled="busy || !ready || !instruction.trim()"
          @click="run()"
        >
          {{ busy ? '生成中…' : '✨ 生成改动' }}
        </button>
        <AiSpin :active="!!busy" label="生成中" />
        <AiThink
          v-model="think"
          hint="整篇重排要判断哪块放错段、哪些重复，开思考通常更准；慢一些、费 token 多一点"
        />
      </div>

      <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

      <template v-if="rows.length">
        <div class="ai-hint ai-hint-bar">
          <span>
            共 {{ rows.length }} 块 —— 挪 {{ counts.move }} / 改 {{ counts.replace }} / 新
            {{ counts.add }} / 删 {{ counts.drop }} / 留 {{ counts.keep }}，勾上的才写进去。
            <template v-if="titleHint">标题会改成「{{ titleHint }}」。</template>
            <template v-if="unchecked">还有 {{ unchecked }} 处没勾。</template>
          </span>
          <span class="ai-bulk">
            <button
              class="ai-bulk-btn"
              :class="{ on: !unchecked }"
              :disabled="!pickable.length"
              @click="setAll(true)"
            >
              全部接受
            </button>
            <button class="ai-bulk-btn" :disabled="!pickable.length" @click="setAll(false)">
              全部不选
            </button>
          </span>
        </div>

        <p v-if="advice" class="ai-msg"><strong>跨笔记：</strong>{{ advice }}</p>
        <p v-if="related.length" class="ai-tip ai-rel">
          这篇旁边还有：{{ related.map((r) => r.title).join('、') }}
        </p>

        <div class="pv-switch">
          <button :class="{ on: view === 'preview' }" @click="view = 'preview'">预览成品</button>
          <button :class="{ on: view === 'diff' }" @click="view = 'diff'">逐条改动</button>
          <span class="pv-sum">
            改后 {{ pvStat.secs }} 段 / {{ pvStat.total }} 块 —— 动了 {{ pvStat.changed }} 块<template
              v-if="pvStat.dropped"
              >，删 {{ pvStat.dropped }} 块</template
            >
          </span>
        </div>

        <div v-if="view === 'preview'" class="pv-split">
          <div class="pv-pane">
            <div class="pv-head">
              <span>原文</span><span class="pv-n">{{ pvStat.src }} 块</span>
            </div>
            <div class="pv-body">
              <div
                v-for="b in note?.blocks || []"
                :key="b.id"
                class="pv-blk"
                :class="{ 'pv-gone': preview && preview.dropped.has(b.id) }"
              >
                <BlockView :block="b" expand />
              </div>
            </div>
          </div>
          <div class="pv-pane pv-new">
            <div class="pv-head">
              <span>改后</span><span class="pv-n">{{ pvStat.total }} 块</span>
            </div>
            <div class="pv-body">
              <div
                v-for="b in preview?.blocks || []"
                :key="b.id"
                class="pv-blk"
                :class="markOf(b.id) ? 'pv-' + markOf(b.id) : ''"
              >
                <BlockView :block="b" expand />
              </div>
            </div>
          </div>
        </div>

        <template v-else>
          <button v-if="counts.keep" class="df-more" @click="showKeep = !showKeep">
            <template v-if="showKeep">收起 {{ counts.keep }} 块没改动的</template>
            <template v-else>下面只列改动，展开还能看 {{ counts.keep }} 块没改动的</template>
          </button>

          <div class="ai-preview ai-diff">
            <div v-for="(r, i) in visibleRows" :key="i" class="df-row" :class="'df-' + r.op">
              <div class="df-tag">
                <template v-if="r.op === 'keep'">保留</template>
                <template v-else>
                  <input v-model="r.checked" type="checkbox" />
                  <span>{{
                    r.op === 'replace' ? '改' : r.op === 'move' ? '移' : r.op === 'add' ? '新' : '删'
                  }}</span>
                </template>
              </div>
              <div class="df-body">
                <p v-if="r.op === 'move'" class="df-from">
                  {{ secName(r.oldSection) }} → {{ secName(r.section) }}
                </p>
                <BlockView v-if="r.op === 'keep' || r.op === 'drop'" :block="r.block" expand />
                <template v-else-if="r.op === 'replace'">
                  <div v-if="r.old" class="df-old">
                    <BlockView :block="r.old" expand />
                  </div>
                  <div class="df-new">
                    <BlockView :block="{ ...r.block, id: r.id + '-pv' }" expand />
                  </div>
                </template>
                <BlockView v-else :block="{ ...r.block, id: 'df-' + r.op + '-' + i }" expand />
              </div>
            </div>
          </div>
        </template>

        <div class="ai-acts">
          <button class="ai-primary" @click="apply">写入笔记</button>
          <button @click="rows = []">放弃</button>
        </div>
      </template>
    </div>
  </div>
</template>
