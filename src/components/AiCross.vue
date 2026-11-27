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
  reviseNotes,
  commitRevises,
  undoRevises,
  assembleBlocks,
  stripMark,
  SECTIONS,
} from '../lib/ai.js'
import BlockView from './BlockView.vue'
import AiThink from './AiThink.vue'
import AiSpin from './AiSpin.vue'
import { searchNotes, blockText } from '../lib/retrieve.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close', 'written'])
const router = useRouter()

const MAX = 6

const cfg = ref(loadAI())
// 深度思考只对这次面板有效：整合/查一致性都是「想清楚再答」受益的活
const think = ref(loadAI().thinking === 'on')
const q = ref('')
const ids = ref([])
const extra = ref('')
const busy = ref('')
const msg = ref('')
const bad = ref(false)

const merged = ref(null) // 整合结果：新笔记草案
const audit = ref(null) // 一致性结果
const revises = ref([]) // 逐篇重构结果
const undoStack = ref([]) // 上次写入的撤销快照

const ready = computed(() => isAiReady(cfg.value))
const spinLabel = computed(
  () => ({ audit: '核对中', revise: '逐篇处理中', merge: '整合中' })[busy.value] || '处理中',
)

// 开关只覆盖这一次请求的 thinking，不动设置里的默认值
const reqCfg = () => ({ ...cfg.value, thinking: think.value ? 'on' : 'off' })

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
    q.value = ''
    ids.value = []
    extra.value = ''
    merged.value = null
    audit.value = null
    revises.value = []
    undoStack.value = []
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
    const r = await mergeNotes({ ids: ids.value, instruction: extra.value, cfg: reqCfg() })
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
    const r = await auditNotes({ ids: ids.value, cfg: reqCfg() })
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

/* ---------- 逐篇原地重构 ---------- */

const OPS = { move: '归档', replace: '改写', add: '新增', drop: '删除', split: '拆出' }
const secName = (id) => (SECTIONS.find((s) => s.id === id) || {}).name || id || '原地'
const clip = (t, n = 64) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// keep 只是「这块看过、别动」的确认，不该占版面也不该算改动
const moves = (it) => (it.ops || []).filter((o) => o.op !== 'keep')
const keepN = (it) => (it.ops || []).filter((o) => o.op === 'keep').length
const usable = (it) => !it.error && moves(it).length > 0
const revCount = computed(() =>
  revises.value.reduce(
    (s, it) => s + (usable(it) ? moves(it).filter((o) => o.checked).length : 0),
    0,
  ),
)

const opText = (o) => {
  if (o.op === 'move') return `${clip(blockText(o.block), 36) || '这块'} → ${secName(o.section)}`
  if (o.op === 'split') return clip(o.to.why, 90) || `把这些块搬进新篇《${o.to.title}》`
  const now = clip(blockText(o.block))
  const old = o.op === 'replace' ? clip(blockText(o.old), 36) : ''
  return old ? `${old} → ${now}` : now
}

const runRevise = async () => {
  if (ids.value.length < 2) return say('先勾两篇以上', true)
  if (!ready.value) return say('还没配 API Key，去「设置」填一下', true)
  busy.value = 'revise'
  merged.value = null
  audit.value = null
  revises.value = []
  undoStack.value = []
  say('')
  try {
    const r = await reviseNotes({
      ids: ids.value,
      instruction: extra.value,
      cfg: reqCfg(),
      onProgress: (p) => say(`第 ${p.index}/${p.total} 篇：${p.title}`),
    })
    revises.value = r
    const dead = r.filter((it) => it.error)
    const still = r.filter((it) => !it.error && !moves(it).length)
    if (dead.length) say(`${dead.length} 篇没跑成，其余的照常可以写`, true)
    else if (still.length === r.length) say('模型觉得这几篇都挺干净，不用动')
    else say('')
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const applyRevises = () => {
  const picked = revises.value.filter(usable)
  if (!revCount.value) return say('一处都没勾，没什么可写的', true)
  undoStack.value = commitRevises(picked)
  const made = undoStack.value.reduce((s, u) => s + u.made.length, 0)
  revises.value = []
  off.value = []
  say(
    `改了 ${undoStack.value.length} 篇${made ? `，另拆出 ${made} 篇新笔记` : ''}。原篇 id 和反链都还在，不满意可以撤销。`,
  )
}

const undoLast = () => {
  if (!undoStack.value.length) return
  undoRevises(undoStack.value)
  undoStack.value = []
  say('已撤销，笔记回到改之前的样子')
}

const KIND = { conflict: '矛盾', dupe: '重复', gap: '缺环' }
</script>

<template>
  <div class="ai-cross">
    <p class="ai-tip">
      勾 2~6 篇，让 AI 横向看一遍。三种用法：<strong>整合</strong>只生成一篇新的，原来那几篇一块都不动；<strong>逐篇处理</strong>是原地改这几篇（该精简的精简、该拆的拆成新篇，原篇 id 和反链都不变，写完能撤销）；<strong>查一致性</strong>纯只读，什么都不写。
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
      placeholder="额外要求（选填）：例，合成一篇《实验平台设计》；或，每篇只留结论，推导过程删掉；或，讲两件事的拆成两篇"
    />

    <div class="ai-acts">
      <button class="ai-primary" :disabled="!!busy || ids.length < 2" @click="runMerge">
        {{ busy === 'merge' ? '整合中…' : '✨ 整合成一篇新笔记' }}
      </button>
      <button :disabled="!!busy || ids.length < 2" @click="runRevise">
        {{ busy === 'revise' ? '逐篇处理中…' : '✍️ 逐篇原地重构' }}
      </button>
      <button :disabled="!!busy || ids.length < 2" @click="runAudit">
        {{ busy === 'audit' ? '核对中…' : '查一致性（只读）' }}
      </button>
      <AiSpin :active="!!busy" :label="spinLabel" />
      <AiThink
        v-model="think"
        hint="整合、逐篇重构、一致性检查都属于想清楚再答的活，开一次试试；会慢一些、费 token 多一点"
      />
    </div>

    <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

    <div v-if="undoStack.length" class="ai-acts">
      <button @click="undoLast">↩︎ 撤销这次写入（回到改之前）</button>
    </div>

    <!-- 逐篇原地重构：每篇一节，勾哪条就写哪条 -->
    <template v-if="revises.length">
      <p class="ai-hint">
        这几篇逐个过完了。改写 / 归档 / 新增默认勾上，<strong>删除和拆篇默认不勾</strong>——抹内容、开新篇都是大动作，自己点一下。<br />
        写入是原地打补丁：块 id 不变，<code>[[链接]]</code> 和反链都跟得上。
      </p>
      <div v-for="it in revises" :key="it.id" class="xg-rev" :class="{ quiet: !usable(it) }">
        <div class="xg-rev-head">
          <span class="xg-rev-title">{{ it.title }}</span>
          <span class="xg-rev-path">{{ it.path }}</span>
          <span v-if="it.error" class="xg-rev-tag bad">失败</span>
          <span v-else-if="!moves(it).length" class="xg-rev-tag">不用动</span>
          <span v-else class="xg-rev-tag on">{{ moves(it).length }} 处</span>
        </div>
        <p v-if="it.error" class="ai-msg bad">{{ it.error }}</p>
        <p v-if="it.nextTitle && it.nextTitle !== it.title" class="xg-rev-line">
          标题改成《{{ it.nextTitle }}》
        </p>
        <p v-if="it.advice" class="xg-rev-line">{{ it.advice }}</p>
        <label v-for="(o, i) in moves(it)" :key="i" class="xg-rev-op" :class="{ off: !o.checked }">
          <input v-model="o.checked" type="checkbox" />
          <span class="xg-op-tag" :class="'op-' + o.op">{{ OPS[o.op] }}</span>
          <span class="xg-op-text">{{ opText(o) }}</span>
        </label>
        <p v-if="keepN(it)" class="xg-rev-keep">另有 {{ keepN(it) }} 块原样留着</p>
      </div>
      <div class="ai-acts">
        <button class="ai-primary" :disabled="!revCount" @click="applyRevises">
          写入勾选的 {{ revCount }} 处改动
        </button>
        <button @click="revises = []">放弃</button>
      </div>
    </template>

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
