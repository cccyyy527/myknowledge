<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  state,
  liveNotes,
  createNote,
  idifyBlocks,
  topicPath,
  flattenTopics,
} from '../lib/store.js'
import {
  loadAI,
  isAiReady,
  mergeNotes,
  auditNotes,
  assembleBlocks,
  stripMark,
} from '../lib/ai.js'
import BlockView from './BlockView.vue'
import { searchNotes } from '../lib/retrieve.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close', 'written'])
const router = useRouter()

const MAX = 6

const cfg = ref(loadAI())
const q = ref('')
const ids = ref([])
const extra = ref('')
const busy = ref('')
const msg = ref('')
const bad = ref(false)

const merged = ref(null) // 整合结果：新笔记草案
const audit = ref(null) // 一致性结果

const ready = computed(() => isAiReady(cfg.value))

const say = (t, isBad = false) => {
  msg.value = t
  bad.value = isBad
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    q.value = ''
    ids.value = []
    extra.value = ''
    merged.value = null
    audit.value = null
    say('')
  },
)

const groups = computed(() =>
  state.domains.map((d) => ({ domain: d, rows: flattenTopics(d.id, true) })),
)

const byUpdated = (a, b) =>
  (new Date(b.updatedAt || b.createdAt || 0).getTime() || 0) -
  (new Date(a.updatedAt || a.createdAt || 0).getTime() || 0)

const pathOf = (id) => (id ? topicPath(id).map((t) => t.name).join(' / ') : '未归类')

const list = computed(() => {
  const kw = q.value.trim()
  const all = [...liveNotes()].sort(byUpdated)
  if (!kw) return all.slice(0, 60)
  // 复用检索层打分：标题、分类、标签、正文一起看，中文按二元组切
  const byId = new Map(all.map((n) => [n.id, n]))
  return searchNotes(kw, { limit: 60 })
    .map((h) => byId.get(h.id))
    .filter(Boolean)
})

const count = (n) => (n.blocks || []).filter((b) => b.type !== 'heading' && b.type).length

const toggle = (id) => {
  const at = ids.value.indexOf(id)
  if (at >= 0) return ids.value.splice(at, 1)
  if (ids.value.length >= MAX) return say(`一次最多 ${MAX} 篇，多了模型也读不过来`, true)
  ids.value.push(id)
  say('')
}

const unpick = (id) => {
  const at = ids.value.indexOf(id)
  if (at >= 0) ids.value.splice(at, 1)
}

const pickedNotes = computed(() => ids.value.map((id) => liveNotes().find((n) => n.id === id)).filter(Boolean))

// 本地检索按打分取前几篇，直接勾上——纯前端算，不花 token
const autoPick = () => {
  const probe = (q.value || extra.value).trim()
  if (!probe) return say('先在上面搜个主题，或者写一句额外要求，我按它挑', true)
  const hits = searchNotes(probe, { limit: MAX })
  if (!hits.length) return say(`「${probe}」没检索到相关笔记，换个说法再试`, true)
  ids.value = hits.map((h) => h.id)
  say(`按「${probe}」挑了 ${hits.length} 篇：${hits.map((h) => h.title).join('、')}`)
}

// 整合结果里哪些块不要：预览逐块勾选，写入时只收勾中的
const off = ref([])
const kept = (b) => !off.value.includes(b.id)
const toggleBlock = (id) => {
  const at = off.value.indexOf(id)
  if (at >= 0) off.value.splice(at, 1)
  else off.value.push(id)
}

const runMerge = async () => {
  if (ids.value.length < 2) return say('先勾两篇以上', true)
  if (!ready.value) return say('还没配 API Key，去「设置」填一下', true)
  busy.value = 'merge'
  merged.value = null
  audit.value = null
  say('')
  try {
    const r = await mergeNotes({ ids: ids.value, instruction: extra.value, cfg: cfg.value })
    merged.value = { ...r, title: r.title, topicId: r.topicId }
    off.value = []
    if (!r.blocks.length) say('模型没切出有效内容，换个组合再试', true)
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const runAudit = async () => {
  if (ids.value.length < 2) return say('先勾两篇以上', true)
  if (!ready.value) return say('还没配 API Key，去「设置」填一下', true)
  busy.value = 'audit'
  merged.value = null
  audit.value = null
  say('')
  try {
    const r = await auditNotes({ ids: ids.value, cfg: cfg.value })
    audit.value = r
    if (!r.items.length) say('这几篇之间没查出对不上的地方')
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const jump = (id) => {
  if (!id) return
  emit('close')
  router.push(`/n/${id}`)
}

const write = () => {
  const m = merged.value
  if (!m || !m.topicId) return
  const keep = m.blocks.filter(kept)
  if (!keep.length) return say('一块都没勾，没什么可写的', true)
  const note = createNote(m.topicId)
  note.title = stripMark(m.title || '').trim() || '整合笔记'
  note.blocks = idifyBlocks(assembleBlocks(keep))
  merged.value = null
  off.value = []
  emit('written', note.id)
  emit('close')
  router.push(`/n/${note.id}`)
}

const KIND = { conflict: '矛盾', dupe: '重复', gap: '缺环' }
</script>

<template>
  <div class="ai-cross">
    <p class="ai-tip">
      勾 2~6 篇，让 AI 横向看一遍。整合只生成一篇新的，原来那几篇一块都不动；一致性检查是纯只读，
      查完什么都不写。<strong>原篇不会被覆盖，放心点。</strong>
    </p>

    <div class="xg-search-row">
      <input v-model="q" class="xg-search" placeholder="搜标题 / 标签 / 分类 / 正文" />
      <button class="xg-auto" title="按这个关键词本地检索，把最相关的几篇直接勾上" @click="autoPick">
        自动挑
      </button>
    </div>

    <div class="xg-list">
      <button
        v-for="n in list"
        :key="n.id"
        class="xg-item"
        :class="{ on: ids.includes(n.id) }"
        @click="toggle(n.id)"
      >
        <span class="xg-box">{{ ids.includes(n.id) ? '✓' : '' }}</span>
        <span class="xg-main">
          <span class="xg-title">{{ n.title }}</span>
          <span class="xg-meta">{{ pathOf(n.topicId) }} · {{ count(n) }} 块</span>
        </span>
      </button>
      <p v-if="!list.length" class="ai-none">没有匹配的笔记</p>
    </div>

    <div v-if="ids.length" class="xg-picked">
      <span class="xg-picked-n">已选 {{ ids.length }} / {{ MAX }}：</span>
      <button v-for="n in pickedNotes" :key="n.id" class="xg-chip" @click="unpick(n.id)">
        {{ n.title }} ×
      </button>
    </div>

    <textarea
      v-model="extra"
      class="ai-area"
      rows="2"
      placeholder="额外要求（选填，只对整合有用）：例，合成一篇《实验平台设计》，把 AA / 灰度 / 互斥放在同一套骨架下"
    />

    <div class="ai-acts">
      <button class="ai-primary" :disabled="!!busy || ids.length < 2" @click="runMerge">
        {{ busy === 'merge' ? '整合中…' : '✨ 整合成一篇新笔记' }}
      </button>
      <button :disabled="!!busy || ids.length < 2" @click="runAudit">
        {{ busy === 'audit' ? '核对中…' : '查一致性（只读）' }}
      </button>
    </div>

    <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

    <!-- 一致性结果 -->
    <template v-if="audit">
      <p class="ai-hint">
        查了 {{ audit.notes.length }} 篇：{{ audit.notes.map((n) => n.title).join('、') }}
      </p>
      <div v-for="(it, i) in audit.items" :key="i" class="xg-find" :class="'xg-' + it.kind">
        <div class="xg-find-head">
          <span class="xg-kind">{{ KIND[it.kind] }}</span>
          <span class="xg-why">{{ it.why }}</span>
        </div>
        <div class="xg-quote">
          <button class="xg-where" :disabled="!it.a.noteId" @click="jump(it.a.noteId)">
            {{ it.a.note || '（未标标题）' }}
          </button>
          <span>「{{ it.a.quote }}」</span>
        </div>
        <div v-if="it.b" class="xg-quote">
          <button class="xg-where" :disabled="!it.b.noteId" @click="jump(it.b.noteId)">
            {{ it.b.note || '（未标标题）' }}
          </button>
          <span>「{{ it.b.quote }}」</span>
        </div>
        <p v-if="it.fix" class="xg-fix">怎么处理：{{ it.fix }}</p>
      </div>
    </template>

    <!-- 整合结果 -->
    <template v-if="merged && merged.blocks.length">
      <div class="ai-cand">
        <div class="ai-cand-head">
          <input v-model="merged.title" class="xg-title-inp" />
          <span class="ai-cand-count">{{ merged.blocks.length }} 块</span>
        </div>
        <label class="ai-pick">
          <span>落到</span>
          <select v-model="merged.topicId">
            <optgroup v-for="g in groups" :key="g.domain.id" :label="g.domain.name">
              <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
                {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
              </option>
            </optgroup>
          </select>
        </label>
        <p class="ai-reason">
          <template v-if="merged.reason">理由：{{ merged.reason }}</template>
          <template v-else>当前挑的是 {{ pathOf(merged.topicId) }}</template>
        </p>
        <p v-if="merged.advice" class="ai-msg"><strong>要注意：</strong>{{ merged.advice }}</p>
        <p class="ai-hint">来源：{{ merged.sources.map((s) => s.title).join('、') }}（这几篇不会被改动）</p>
      </div>

      <div class="ai-preview">
        <div v-for="b in merged.blocks" :key="b.id" class="xg-block" :class="{ off: !kept(b) }">
          <label class="xg-keep" :title="kept(b) ? '不想要这块就取消勾选' : '已排除，不会写入'">
            <input type="checkbox" :checked="kept(b)" @change="toggleBlock(b.id)" />
          </label>
          <div class="xg-block-body">
            <BlockView :block="b" />
          </div>
        </div>
      </div>

      <div class="ai-acts">
        <button class="ai-primary" @click="write">
          写入新笔记（{{ merged.blocks.filter(kept).length }} 块）
        </button>
        <button @click="merged = null">放弃</button>
      </div>
    </template>
  </div>
</template>
