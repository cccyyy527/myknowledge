<script setup>
import { computed } from 'vue'
import { SECTIONS, stripMark, secTitle } from '../lib/ai.js'
import { state, liveNotes, liveNoteById, flattenTopics, topicPath } from '../lib/store.js'
import { attachRefs, groupBySection, plainBlocks } from '../lib/draft.js'
import BlockView from './BlockView.vue'

// saving 是「这次要存成什么」的草稿对象：面板只负责让它能被看、被改，落库在父组件
const props = defineProps({
  saving: { type: Object, required: true },
  turn: { type: Object, default: null },
})
const emit = defineEmits(['close', 'retry', 'save'])

const groups = computed(() =>
  state.domains.map((d) => ({ domain: d, rows: flattenTopics(d.id, true) })),
)

// 拿块的首句当标签，用来告诉用户「插在哪块后面」
function labelOf(noteId, blockId) {
  const note = liveNoteById(noteId)
  const b = note?.blocks?.find((x) => x.id === blockId)
  if (!b) return ''
  const raw = b.text || b.term || b.question || b.items?.[0] || b.latex || ''
  const t = stripMark(String(raw)).replace(/\s+/g, ' ').trim()
  return t.length > 18 ? t.slice(0, 18) + '…' : t
}

// 改已有块时按条目渲染「旧 → 新」对照
const editPlan = computed(() => {
  const s = props.saving
  if (s.mode !== 'edit' || !s.edits?.length) return []
  return s.edits.map((e, i) => ({
    key: `ed${i}`,
    op: e.op,
    why: e.why,
    before: e.before,
    after: e.after,
    afterTitle: e.op === 'insert' ? labelOf(s.noteId, e.afterBlockId) : '',
    // 归位不涉内容，只交代「从哪段到哪段」
    moveFrom: e.op === 'move' ? secTitle(e.from || e.before?.section) : '',
    moveTo: e.op === 'move' ? secTitle(e.to || e.after?.section) : '',
  }))
})

const OP_TEXT = { replace: '改写', remove: '删除', insert: '就地插入', move: '挪段' }

// 逐条勾选：默认全选，勾掉的这次不会写进笔记
const kept = (i) => !(props.saving.offEdits || []).includes(i)
const toggle = (i) => {
  const s = props.saving
  const off = s.offEdits || (s.offEdits = [])
  const at = off.indexOf(i)
  if (at >= 0) off.splice(at, 1)
  else off.push(i)
}
const keptCount = computed(() => editPlan.value.filter((e, i) => kept(i)).length)

const noteOptions = computed(() =>
  liveNotes().map((n) => ({
    id: n.id,
    title: n.title,
    path: topicPath(n.topicId).map((t) => t.name).join(' / '),
  })),
)

const editingNote = computed(() => liveNoteById(props.saving.noteId))

// 预览：有 AI 分块就按段落排，没有就退回一张问答卡
const savingBlocks = computed(() => {
  const s = props.saving
  const refs = (props.turn?.used || []).map((x) => ({ id: x.id, title: x.title }))
  return s.blocks?.length ? groupBySection(attachRefs(s.blocks, refs)) : plainBlocks(props.turn)
})

const pathOf = (id) => (id ? topicPath(id).map((t) => t.name).join(' / ') : '')

// 「其实还有更该写进去的那篇」：模型被要求交代它放弃了谁，
// 这里把它摆到明面上，用户点一下就改投过去，不用自己翻列表
const alt = computed(() => {
  const a = props.saving.alt
  if (!a || props.saving.mode === 'edit') return null
  // 已经在这篇上了就别再劝一次
  if (props.saving.mode === 'exist' && props.saving.noteId === a.noteId) return null
  const note = liveNoteById(a.noteId)
  return note ? { ...a, title: note.title } : null
})
const useAlt = () => {
  const a = alt.value
  if (!a) return
  props.saving.noteId = a.noteId
  props.saving.mode = 'exist'
}

// 写前检查：程序能算出来的毛病（部分重叠、段落和类型对不上、超长一段、全挤在一段），
// 落库前就摆出来，别让用户写完再自己通读一遍才发现
const checks = computed(() => (props.saving.mode === 'edit' ? [] : props.saving.checks || []))
const checkCount = computed(() => checks.value.filter((c) => c.level === 'warn').length)

// 预览里的引用 chip：开新标签看原文，别把面板连同草稿一起关掉
const openCite = (id) => window.open(`${location.pathname}#/n/${id}`, '_blank')
</script>

<template>
  <div class="ask-save-box">
    <div class="ask-save-head">
      <span>存成笔记</span>
      <button class="ask-save-x" title="取消" @click="emit('close')">×</button>
    </div>

    <p v-if="saving.analyzing" class="ask-save-why">✨ AI 正在判断该新建还是追加、内容怎么分块…</p>
    <div v-if="saving.trace && saving.trace.length" class="ask-trace ask-trace-save">
      <span v-for="(g, k) in saving.trace" :key="k" class="ask-trace-i">{{ g }}</span>
    </div>
    <template v-else-if="saving.reason || saving.err">
      <p v-if="saving.err" class="ai-msg bad">{{ saving.err }}</p>
      <p v-else class="ask-save-why">✨ {{ saving.reason }}</p>
      <button class="ask-save-retry" @click="emit('retry')">↻ 让 AI 重新判断</button>
    </template>

    <div v-if="alt" class="ask-alt">
      <span class="ask-alt-q">另一个落点</span>
      <span class="ask-alt-t">《{{ alt.title }}》</span>
      <span v-if="alt.why" class="ask-alt-w">{{ saving.mode === 'new' ? '没写进去是因为' : '按内容看更像它：' }}{{ alt.why }}</span>
      <button class="ask-alt-go" @click="useAlt">改投这篇</button>
    </div>

    <div v-if="checks.length" class="ask-checks">
      <p class="ask-checks-h">
        写前检查<span> {{ checks.length }} 条{{ checkCount ? `，${checkCount} 条建议改完再写` : '' }}</span>
      </p>
      <p v-for="(c, k) in checks" :key="k" class="ask-check" :class="c.level">{{ c.text }}</p>
    </div>

    <div class="ask-save-mode">
      <button :class="{ on: saving.mode === 'new' }" @click="saving.mode = 'new'">新建一篇</button>
      <button
        :class="{ on: saving.mode === 'exist' }"
        :disabled="!noteOptions.length"
        @click="saving.mode = 'exist'"
      >
        写进已有笔记
      </button>
      <button v-if="saving.plan" :class="{ on: saving.mode === 'edit' }" @click="saving.mode = 'edit'">
        改已有内容
      </button>
    </div>

    <template v-if="saving.mode === 'edit'">
      <p class="ask-save-path">
        改《{{ editingNote?.title || '这篇' }}》{{ editPlan.length }} 处，这次应用 {{ keptCount }} 处<span
          v-if="saving.skipped?.length"
        >
          ，另有 {{ saving.skipped.length }} 处对不上被丢掉</span
        >
      </p>
      <div class="ask-edits">
        <div v-for="(e, i) in editPlan" :key="e.key" class="ask-edit" :class="{ off: !kept(i) }">
          <div class="ask-edit-head">
            <label class="ask-edit-pick">
              <input type="checkbox" :checked="kept(i)" @change="toggle(i)" />
              <span class="ask-edit-op" :class="e.op">{{ OP_TEXT[e.op] || e.op }}</span>
            </label>
            <span v-if="e.afterTitle" class="ask-edit-at">插在「{{ e.afterTitle }}」后面</span>
            <span v-if="e.op === 'move'" class="ask-edit-at">
              从「{{ e.moveFrom || '别处' }}」挪到「{{ e.moveTo }}」
            </span>
            <span v-if="e.why" class="ask-edit-why">{{ e.why }}</span>
          </div>
          <template v-if="e.op === 'move'">
            <div class="ask-edit-after">
              <BlockView :block="e.after" expand />
            </div>
          </template>
          <template v-else>
            <div v-if="e.before" class="ask-edit-before" :class="{ gone: e.op === 'remove' }">
              <BlockView :block="e.before" expand />
            </div>
            <div v-if="e.after" class="ask-edit-after">
              <BlockView :block="e.after" expand @open-note="openCite" />
            </div>
          </template>
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
      <label class="ai-pick">
        <span>顺带换分类</span>
        <select v-model="saving.moveTo">
          <option value="">不换，留在 {{ pathOf(editingNote?.topicId) }}</option>
          <optgroup v-for="g in groups" :key="g.domain.id" :label="g.domain.name">
            <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
              {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
            </option>
          </optgroup>
        </select>
      </label>
      <p v-if="saving.moveTo" class="ask-save-path">
        写完连这篇一起挪到 {{ pathOf(saving.moveTo) }}
      </p>
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
      <BlockView v-for="b in savingBlocks" :key="b.id" :block="b" expand @open-note="openCite" />
    </div>
    <div class="ai-acts">
      <button
        class="ai-primary"
        :disabled="saving.analyzing || (saving.mode === 'edit' && !keptCount)"
        @click="emit('save')"
      >
        {{
          saving.mode === 'edit'
            ? `应用改动${keptCount ? `（${keptCount} 处）` : ''}`
            : saving.mode === 'exist'
              ? '写进这篇'
              : '写入新笔记'
        }}
      </button>
      <button @click="emit('close')">取消</button>
    </div>
  </div>
</template>
