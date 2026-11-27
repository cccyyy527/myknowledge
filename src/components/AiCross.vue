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
  planCross,
  commitCross,
  undoCross,
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
const ask = ref('')
const extra = ref('')
const busy = ref('')
const msg = ref('')
const bad = ref(false)

const plan = ref(null) // 提问结果：一段回答 + 一份能点的清单
const planUndo = ref(null) // 上次执行清单的撤销快照
const merged = ref(null) // 整合结果：新笔记草案
const audit = ref(null) // 一致性结果
const revises = ref([]) // 逐篇重构结果
const undoStack = ref([]) // 上次写入的撤销快照

const ready = computed(() => isAiReady(cfg.value))
const spinLabel = computed(
  () => ({ ask: '看这几篇', audit: '核对中', revise: '逐篇处理中', merge: '整合中' })[busy.value] || '处理中',
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
    ask.value = ''
    extra.value = ''
    plan.value = null
    planUndo.value = null
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

/* ---------- 提问：一句话问这几篇，回来的是一份能点的清单 ---------- */

const ASKS = [
  '这几篇之间有没有说法对不上的？',
  '有没有讲同一件事、该并掉的？',
  '有没有拆得不清、该拆成两篇的？',
  '每篇都需要留着吗？',
]

const PLAN_TEXT = {
  move: '归位',
  merge: '合并',
  reword: '改写',
  drop: '删除',
  fold: '并篇',
  split: '拆篇',
  keep: '保留',
}

const runAsk = async () => {
  if (!ids.value.length) return say('先勾一篇以上', true)
  if (!ask.value.trim()) return say('先写一句你要问的', true)
  if (!ready.value) return say('还没配 API Key，去「设置」填一下', true)
  busy.value = 'ask'
  plan.value = null
  planUndo.value = null
  merged.value = null
  audit.value = null
  revises.value = []
  say('')
  try {
    const r = await planCross({ ids: ids.value, question: ask.value, cfg: reqCfg() })
    plan.value = r
    if (!r.answer) say('模型没给回答，换个问法再试', true)
    else if (!r.items.length) say('这几篇没查出要动的地方')
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const planCount = computed(() =>
  plan.value ? plan.value.items.filter((it) => it.checked && it.op !== 'keep').length : 0,
)

const applyPlan = () => {
  if (!planCount.value) return say('一项都没勾，没什么可做的', true)
  const undo = commitCross(plan.value.items)
  planUndo.value = undo
  plan.value = null
  const parts = []
  if (undo.notes.length) parts.push(`改了 ${undo.notes.length} 篇`)
  if (undo.made.length) parts.push(`拆出 ${undo.made.length} 篇新笔记`)
  if (undo.restored.length) parts.push(`${undo.restored.length} 篇并进别篇、已进回收站`)
  say(parts.length ? `${parts.join('，')}。不满意可以撤销。` : '这几条实际没什么可改的')
}

const undoPlan = () => {
  if (!planUndo.value) return
  undoCross(planUndo.value)
  planUndo.value = null
  say('已撤销，笔记回到改之前的样子')
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
const secName = (id) => (SECTIONS.find((s) => s.id === id) || {}).title || id || '原地'
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

// 清单每条写清「动哪一块、动成什么样」，别让人靠猜
const planText = (it) => {
  const body = clip(blockText(it.block), 52)
  if (it.op === 'move') return `「${body}」→ ${secName(it.to)}`
  if (it.op === 'merge') {
    const keep = clip(blockText(it.otherBlock), 40)
    return `留「${keep}」（${it.otherNoteTitle} · ${secName(it.otherSection)}），删掉这条「${body}」`
  }
  if (it.op === 'reword') return `「${body}」→「${clip(blockText(it.next), 52)}」`
  if (it.op === 'drop') return `删掉「${body}」`
  if (it.op === 'fold') return `《${it.fromTitle}》并进《${it.noteTitle}》，前者进回收站`
  if (it.op === 'split') return `《${it.noteTitle}》里 ${it.blockIds.length} 块拆成《${it.title}》`
  return ''
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
      勾几篇（最多 6 篇），直接问它们一句话：<strong>哪里对不上、哪里讲重了、哪篇该拆、哪篇该并</strong>。AI 先给结论，再给一张能点的清单——归位、合并、改写、删块、拆篇、并篇，你勾哪条它才做哪条，做完能撤销。
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
      v-model="ask"
      class="ai-area"
      rows="2"
      placeholder="直接问，例：这两篇讲的是不是一回事？有没有说法对不上的？哪篇该拆？"
      @keydown.ctrl.enter="runAsk"
    />

    <div class="xg-ask-tags">
      <button v-for="s in ASKS" :key="s" class="xg-chip" @click="ask = s">{{ s }}</button>
    </div>

    <div class="ai-acts">
      <button class="ai-primary" :disabled="!!busy || !ids.length" @click="runAsk">
        {{ busy === 'ask' ? '看这几篇…' : '🔍 问这几篇' }}
      </button>
      <AiSpin :active="!!busy" :label="spinLabel" />
      <AiThink
        v-model="think"
        hint="横向读几篇、还要判断该合并还是该拆，属于想清楚再答的活；开一次试试，会慢一些、费 token 多一点"
      />
    </div>

    <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

    <!-- 提问结果：先是一段回答，再是一张能点的清单 -->
    <template v-if="plan">
      <div class="xg-answer">
        <p class="xg-answer-title">这 {{ plan.notes.length }} 篇看下来</p>
        <p class="xg-answer-body">{{ plan.answer }}</p>
      </div>

      <template v-if="plan.items.length">
        <p class="ai-hint">
          <strong>勾哪条我做哪条</strong>，不勾就原样留着。删除、并篇、拆篇默认不勾——抹内容、开新篇都是大动作，自己点一下。
        </p>
        <div class="xg-plan">
          <label v-for="it in plan.items" :key="it.key" class="xg-plan-row" :class="{ off: !it.checked }">
            <input v-if="it.op !== 'keep'" v-model="it.checked" type="checkbox" />
            <span v-else class="xg-plan-dot">·</span>
            <span class="xg-op-tag" :class="'op-' + it.op">{{ PLAN_TEXT[it.op] }}</span>
            <span class="xg-plan-main">
              <span class="xg-plan-text">
                <template v-if="it.op === 'keep'">《{{ it.noteTitle }}》留着，不用动</template>
                <template v-else-if="it.op !== 'fold' && it.op !== 'split'">
                  <span class="xg-plan-where">{{ it.noteTitle }} · {{ secName(it.section) }}</span>
                  {{ planText(it) }}
                </template>
                <template v-else>{{ planText(it) }}</template>
              </span>
              <span v-if="it.why" class="xg-plan-why">{{ it.why }}</span>
            </span>
          </label>
        </div>
        <div class="ai-acts">
          <button class="ai-primary" :disabled="!planCount" @click="applyPlan">
            写入勾选的 {{ planCount }} 处
          </button>
          <button @click="plan = null">放弃</button>
        </div>
      </template>
    </template>

    <div v-if="planUndo" class="ai-acts">
      <button @click="undoPlan">↩︎ 撤销这次写入（回到改之前）</button>
    </div>

    <!-- 老的三条路径收进这里，不占主动作的位置 -->
    <details class="xg-manual">
      <summary>手动模式：整合成新篇 / 逐篇原地重构 / 查一致性（只读）</summary>
      <textarea
        v-model="extra"
        class="ai-area"
        rows="2"
        placeholder="额外要求（选填）：例，合成一篇《实验平台设计》；或，每篇只留结论，推导过程删掉；或，讲两件事的拆成两篇"
      />
      <div class="ai-acts">
        <button :disabled="!!busy || ids.length < 2" @click="runMerge">
          {{ busy === 'merge' ? '整合中…' : '✨ 整合成一篇新笔记' }}
        </button>
        <button :disabled="!!busy || ids.length < 2" @click="runRevise">
          {{ busy === 'revise' ? '逐篇处理中…' : '✍️ 逐篇原地重构' }}
        </button>
        <button :disabled="!!busy || ids.length < 2" @click="runAudit">
          {{ busy === 'audit' ? '核对中…' : '查一致性（只读）' }}
        </button>
      </div>
    </details>

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
