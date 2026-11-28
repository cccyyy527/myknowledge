<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { loadAI, isAiReady, askLibrary, askAgent, archiveAgent, fileAnswer, assembleBlocks, applyChanges, stripMark, SECTIONS, enabledSkills, loadSkillPref, saveSkillPref, writeChecks } from '../lib/ai.js'
import { libraryStats } from '../lib/retrieve.js'
import { attachRefs, cleanBlocks, plainBlocks } from '../lib/draft.js'
import {
  state,
  createNote,
  newBlockId,
  flattenTopics,
  idifyBlocks,
  insertBlocks,
  liveNoteById,
  liveNotes,
  moveNote,
  touchNote,
} from '../lib/store.js'
import AiSavePanel from './AiSavePanel.vue'
import AiThink from './AiThink.vue'
import { logRun } from '../lib/ai/cross.js'
import { resolveLink } from '../lib/links.js'

const emit = defineEmits(['close', 'setup'])
const router = useRouter()

const SUGGEST = [
  '库里关于方差缩减的坑有哪些？',
  'CUPED 和分层调整的区别是什么？',
  '我还有哪些没查清的地方？',
]

// 对话记录落 localStorage：关掉面板、刷新页面再打开，模型还记得刚才聊过什么、读过哪几块
const LOG_KEY = 'myknowledge.asklog'
const LOG_MAX = 10

const loadLog = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.slice(-LOG_MAX).map((t) => ({ ...t, streaming: false, trace: [] }))
  } catch {
    return []
  }
}

const input = ref('')
const turns = ref(loadLog())
const busy = ref(false)
const box = ref(null)
let ctrl = null

// 面试前怕被 AI 的通用知识带偏，就锁死只查笔记
const STRICT_KEY = 'myknowledge.askStrict'
const strict = ref(localStorage.getItem(STRICT_KEY) === '1')
watch(strict, (v) => {
  try {
    localStorage.setItem(STRICT_KEY, v ? '1' : '0')
  } catch {}
})

const ready = computed(() => isAiReady(loadAI()))
const stats = computed(() => libraryStats())

// 深度思考：默认跟随设置，但这里可以临时改，只影响本次面板的请求
const think = ref(loadAI().thinking === 'on')
const reqCfg = () => ({ ...loadAI(), thinking: think.value ? 'on' : 'off' })

// 技能只影响语气和回答套路，不影响检索；选中的存在 localStorage，下次进来还用它
const skills = enabledSkills()
const skill = ref(loadSkillPref().id)
const pickSkill = (id) => {
  skill.value = id
  saveSkillPref({ id })
}
const curSkill = computed(() => skills.find((s) => s.id === skill.value))
const skillName = (id) => (id ? skills.find((s) => s.id === id)?.name || '' : '')

// 端点不一定支持 tools（DeepSeek 支持，自建反代常常不支持）：
// 试崩一次就记住，后面直接走老的预检索流程，别每问一次都白等一轮
const AGENT_KEY = 'myknowledge.agent'
const agentOk = ref(localStorage.getItem(AGENT_KEY) !== '0')
const turnOffAgent = () => {
  agentOk.value = false
  try {
    localStorage.setItem(AGENT_KEY, '0')
  } catch {}
}

const scroll = async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}

// messages 里有工具回包，体积能到几百 KB，超配额就逐级瘦身
let logTimer = 0
const capContent = (list, n) =>
  (list || []).map((m) =>
    typeof m.content === 'string' && m.content.length > n
      ? { ...m, content: m.content.slice(0, n) + '\n…（已截断）' }
      : m,
  )

const writeLog = (list) => {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list))
    return
  } catch {}
  try {
    localStorage.setItem(
      LOG_KEY,
      JSON.stringify(list.map((t) => ({ ...t, messages: capContent(t.messages, 4000) }))),
    )
    return
  } catch {}
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.map((t) => ({ ...t, messages: null }))))
  } catch {}
}

const saveLog = () => {
  clearTimeout(logTimer)
  logTimer = setTimeout(() => {
    writeLog(
      turns.value.slice(-LOG_MAX).map((t) => ({
        q: t.q,
        a: t.a,
        used: t.used || [],
        strict: t.strict,
        fallback: t.fallback,
        err: t.err || '',
        messages: t.messages || null,
        at: t.at || 0,
      })),
    )
  }, 500)
}

const clearLog = () => {
  clearTimeout(logTimer)
  try {
    localStorage.removeItem(LOG_KEY)
  } catch {}
}

onMounted(scroll)

const ask = async (preset) => {
  const q = String(preset ?? input.value).trim()
  if (!q || busy.value) return
  if (!ready.value) return emit('setup')

  // 只带最近几轮全文，更早的在 trimHistory 里压成话题索引，问答本身比历史更重要
  const history = []
  for (const t of turns.value.slice(-8)) {
    history.push({ role: 'user', content: t.q })
    if (t.a) history.push({ role: 'assistant', content: t.a })
  }

  input.value = ''
  turns.value.push({
    q,
    a: '',
    think: '',
    showThink: true,
    used: [],
    trace: [],
    streaming: true,
    err: '',
    fallback: false,
    strict: strict.value,
    skill: skill.value,
    messages: null,
    at: Date.now(),
  })
  const turn = turns.value[turns.value.length - 1]
  busy.value = true
  scroll()

  ctrl = new AbortController()
  let done = false
  try {
    if (agentOk.value) {
      try {
        const r = await askAgent({
          question: q,
          history,
          cfg: reqCfg(),
          strict: strict.value,
          skill: skill.value,
          signal: ctrl.signal,
          onDelta: (_, full) => {
            turn.a = full
            if (turn.think) turn.showThink = false
            scroll()
          },
          onThink: (_, full) => {
            turn.think = full
            scroll()
          },
          onTrace: (line) => {
            turn.trace.push(line)
            // 工具轮里模型可能先嘀咕两句，那不是答案；等它查到东西再重新开始攒
            turn.a = ''
            scroll()
          },
        })
        turn.a = r.text
        turn.used = r.refs
        turn.messages = r.messages
        // 用户当场让它改笔记时，agent 会直接提交提案 —— 这里把面板打开，别只留一句「提案已记录」
        if (r.proposal) {
          const s = blankSaving(turn)
          s.idx = turns.value.length - 1
          applyProposal(s, r.proposal)
          saving.value = s
        }
        done = true
      } catch (e) {
        if (e.name === 'AbortError' || !e.noTools) throw e
        turnOffAgent()
        turn.trace = []
        turn.a = ''
      }
    }

    if (!done) {
      const r = await askLibrary({
        question: q,
        history,
        cfg: reqCfg(),
        strict: strict.value,
        skill: skill.value,
        signal: ctrl.signal,
        onDelta: (_, full) => {
          turn.a = full
          if (turn.think) turn.showThink = false
          scroll()
        },
        onThink: (_, full) => {
          turn.think = full
          scroll()
        },
      })
      turn.a = r.text
      turn.used = r.used
      turn.fallback = r.fallback
      turn.strict = r.strict
    }
  } catch (e) {
    if (e.name === 'AbortError') turn.a = turn.a || '（已停止）'
    else turn.err = String(e.message || e)
  } finally {
    turn.streaming = false
    busy.value = false
    ctrl = null
    saveLog()
    scroll()
  }
}

const stop = () => ctrl && ctrl.abort()

const reset = () => {
  if (busy.value) return
  turns.value = []
  saving.value = null
  clearLog()
}

const jump = (id) => {
  emit('close')
  router.push(`/n/${id}`)
}

const onThreadClick = (e) => {
  const el = e.target.closest && e.target.closest('.ask-cite, .ask-link')
  if (el && el.dataset.note) jump(el.dataset.note)
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 只支持粗体 / 行内代码 / [n] 引用 / [[笔记标题]]，够用且不会被模型带进奇怪的 HTML
const rich = (text, used = []) => {
  if (!text) return ''
  // [[ ]] 先换成占位符：标题原样比较（esc 之后对不上），也别让 [n] 规则把它吃了
  const links = []
  let raw = stripMark(text).replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (_m, t) => {
    links.push(t.trim())
    return `\u0000${links.length - 1}\u0000`
  })
  let s = esc(raw)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[(\d+)\]/g, (m, d) => {
    const n = Number(d)
    if (n < 1 || n > used.length) return m
    return `<button class="ask-cite" data-note="${used[n - 1].id}">${n}</button>`
  })
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const raw = links[Number(i)] || ''
    const cut = raw.indexOf('|')
    const target = (cut < 0 ? raw : raw.slice(0, cut)).trim()
    const display = cut < 0 ? '' : raw.slice(cut + 1).trim()
    const hit = resolveLink({ target, display }, liveNotes())
    const label = display || (hit ? hit.title : target)
    return hit
      ? `<button class="ask-link" data-note="${hit.id}" title="跳到《${esc(hit.title)}》">${esc(label)}</button>`
      : `<span class="ask-link missing" title="库里还没有这篇">${esc(label)}</span>`
  })
}

// 回答里出现「【库外】」时，后面那段是模型自己的知识，要单独标出来。
// 这个标记只给这里用：切完再抹一遍，正文里永远不会露出这几个字
const OUT_RE = /【\s*库外(?:补充)?\s*】/
const splitOutside = (text) => {
  const s = String(text || '')
  const m = s.match(OUT_RE)
  if (!m) return { inside: stripMark(s), outside: '' }
  return {
    inside: stripMark(s.slice(0, m.index)),
    outside: stripMark(s.slice(m.index + m[0].length)),
  }
}

/* ---------- 把一条回答存成笔记 ---------- */

const saving = ref(null) // { idx, mode, topicId, noteId, section, outside, title, blocks, reason, analyzing, err }

// 面板里改的是哪一条回答
const savingTurn = computed(() => (saving.value ? turns.value[saving.value.idx] : null))

const blankTitle = (q) => (q.length > 38 ? q.slice(0, 38) + '…' : q)

// 提案落到面板字段上：agent 自己提交的提案、和「存成笔记」让 AI 判断，都走这里
const applyProposal = (s, r) => {
  s.reason = stripMark(r.reason || '')
  s.err = ''
  s.alt = r.alt || null
  // 走 agent 归档的提案自带复核结果；退回一次性归档判断的那条路没有，就在这儿补算一遍：
  // 程序能算出来的毛病，没必要等用户落库后自己通读才发现
  s.checks =
    r.checks?.length || r.target === 'edit'
      ? r.checks || []
      : writeChecks(r.blocks, { note: r.target === 'exist' ? liveNoteById(r.noteId) : null })
  if (r.target === 'edit') {
    s.mode = 'edit'
    s.noteId = r.noteId
    s.blocks = null
    s.edits = r.edits || []
    s.offEdits = []
    s.plan = r.blocks || []
    s.skipped = r.skipped || []
    return
  }
  s.blocks = r.blocks
  s.mode = r.target
  s.section = r.section
  s.edits = []
  s.offEdits = []
  s.plan = null
  s.skipped = []
  if (r.target === 'exist') s.noteId = r.noteId
  else {
    s.topicId = r.topicId
    // 模型给的标题更像笔记名，但用户改过的就别覆盖
    if (r.title && !s.touchedTitle) s.title = stripMark(r.title)
  }
}

const blankSaving = (t) => {
  const srcNote = t.used[0] && liveNoteById(t.used[0].id)
  const anyTopic = flattenTopics(state.domains[0]?.id, true)[0]?.topic?.id || ''
  return {
    idx: null,
    mode: 'new',
    topicId: srcNote?.topicId || anyTopic,
    noteId: srcNote?.id || liveNotes()[0]?.id || '',
    section: 'qa',
    title: blankTitle(t.q),
    moveTo: '',
    blocks: null,
    edits: [],
    offEdits: [],
    plan: null,
    skipped: [],
    reason: '',
    alt: null,
    checks: [],
    analyzing: false,
    err: '',
    trace: [],
    touchedTitle: false,
  }
}

const analyze = async (idx) => {
  const t = turns.value[idx]
  const s = saving.value
  if (!t || !s || s.analyzing) return
  s.analyzing = true
  s.err = ''
  s.trace = []
  try {
    let r = null
    // 沿着问答那轮的会话往下问：模型还记着刚查过哪些笔记、哪篇是空的
    if (t.messages?.length && agentOk.value) {
      try {
        const out = await archiveAgent({
          messages: t.messages,
          refs: t.used.map((x) => ({ id: x.id, title: x.title })),
          cfg: reqCfg(),
          onTrace: (line) => {
            if (saving.value !== s) return
            s.trace.push(line)
            scroll()
          },
        })
        if (out.proposal) {
          t.messages = out.messages
          r = out.proposal
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e
        if (e.noTools) turnOffAgent()
        // 会话续不上就退回一次性归档判断，别让用户看到错误
      }
    }
    if (!r) {
      r = await fileAnswer({
        question: t.q,
        answer: stripMark(t.a),
        used: t.used,
        cfg: reqCfg(),
      })
    }
    if (saving.value !== s) return
    applyProposal(s, r)
  } catch (e) {
    if (saving.value === s) s.err = String(e.message || e)
  } finally {
    if (saving.value === s) s.analyzing = false
  }
}

const openSave = (idx) => {
  const t = turns.value[idx]
  const s = blankSaving(t)
  s.idx = idx
  saving.value = s
  if (ready.value) analyze(idx)
}

// 落库前的快照：以前这三条路直接改 blocks，改完就没有回头路（跨笔记那边早有快照，
// 问答归档却没有）。深拷贝，别让后面原地改块时把快照一起改了
const snapOf = (n) => ({
  title: n.title,
  topicId: n.topicId,
  domainId: n.domainId,
  blocks: JSON.parse(JSON.stringify(n.blocks || [])),
})

const doSave = () => {
  const t = savingTurn.value
  const s = saving.value
  if (!t || !s || s.analyzing) return

  const refs = t.used.map((x) => ({ id: x.id, title: x.title }))
  const ai = s.blocks?.length ? attachRefs(s.blocks, refs) : null
  const body = ai || plainBlocks(t)

  const clean = (list) => cleanBlocks(list, newBlockId)
  // 落完库把这次写入记进流水：面板一关就找不回来的那种反悔，不该再有了
  const log = (undo, note) =>
    logRun({
      kind: 'ask',
      question: t.q,
      answer: '',
      lines: [`《${note.title}》${s.mode === 'edit' ? `改 ${(s.edits || []).length - (s.offEdits || []).length} 处` : `加 ${s.blocks?.length || 0} 块`}`],
      undo,
    })

  if (s.mode === 'edit') {
    const note = liveNoteById(s.noteId)
    const picked = (s.edits || []).filter((_, i) => !(s.offEdits || []).includes(i))
    if (!note || !picked.length) return
    const before = snapOf(note)
    note.blocks = applyChanges(note, picked)
    touchNote(note)
    log({ notes: [{ id: note.id, before, made: [] }] }, note)
    saving.value = null
    emit('close')
    router.push(`/n/${note.id}`)
    return
  }

  if (s.mode === 'exist') {
    const note = liveNoteById(s.noteId)
    if (!note) return
    const before = snapOf(note)
    if (ai) {
      // AI 已经把每块归好段了，按段落分别拼进去
      for (const sec of SECTIONS) {
        const items = clean(ai.filter((b) => (b.section || 'core') === sec.id))
        if (items.length) insertBlocks(note, sec.title, items)
      }
    } else {
      const sec = SECTIONS.find((x) => x.id === s.section) || SECTIONS[0]
      insertBlocks(note, sec.title, clean(body))
    }
    touchNote(note)
    if (s.moveTo && s.moveTo !== note.topicId) moveNote(note.id, s.moveTo)
    log({ notes: [{ id: note.id, before, made: [] }] }, note)
    saving.value = null
    emit('close')
    router.push(`/n/${note.id}`)
    return
  }

  if (!s.topicId) return
  const note = createNote(s.topicId)
  note.title = (s.title || '').trim() || blankTitle(t.q)
  note.blocks = idifyBlocks(clean(ai ? assembleBlocks(ai) : body))
  log({ notes: [{ id: '', before: null, made: [note.id] }] }, note)
  saving.value = null
  emit('close')
  router.push(`/n/${note.id}`)
}

</script>

<template>
  <div class="ask">
    <div class="ask-bar">
      <p class="ai-tip">
        先在你的笔记里找答案。笔记里没有、AI 自己知道的那部分会单独放在「AI 补充」里。现在库里
        {{ stats.notes }} 篇 / {{ stats.blocks }} 个知识块。
      </p>
      <label class="ask-strict" :class="{ on: strict }">
        <input type="checkbox" v-model="strict" />
        <span>只查我的笔记</span>
      </label>
      <AiThink
        v-model="think"
        hint="让模型先想一段再答；查库、跨笔记比对这类活通常更准，慢一些、费 token 多一点"
      />
    </div>

    <div v-if="skills.length > 1" class="ask-skills">
      <span class="ask-skills-lb">技能</span>
      <button
        v-for="s in skills"
        :key="s.id"
        class="ask-skill"
        :class="{ on: skill === s.id }"
        :title="s.desc"
        @click="pickSkill(s.id)"
      >
        {{ s.name }}
      </button>
      <span v-if="curSkill && curSkill.system" class="ask-skill-d">{{ curSkill.desc }}</span>
    </div>

    <div v-if="!turns.length" class="ask-sugs">
      <button v-for="s in SUGGEST" :key="s" class="ask-sug" @click="ask(s)">{{ s }}</button>
    </div>

    <div ref="box" class="ask-thread" @click="onThreadClick">
      <div v-for="(t, i) in turns" :key="i" class="ask-turn">
        <div class="ask-q">
          <span v-if="skillName(t.skill)" class="ask-q-sk">{{ skillName(t.skill) }}</span>
          {{ t.q }}
        </div>
        <div class="ask-a">
          <p v-if="t.err" class="ai-msg bad">{{ t.err }}</p>
          <template v-else>
            <div v-if="t.think" class="ask-think" :class="{ live: t.streaming && !t.a }">
              <button class="ask-think-h" @click="t.showThink = !t.showThink">
                <span class="ask-think-dot"></span>
                {{ t.streaming && !t.a ? '正在思考' : '思考过程' }}
                <span class="ask-think-n">{{ t.think.length }} 字</span>
                <span class="ask-think-ar">{{ t.showThink ? '收起' : '展开' }}</span>
              </button>
              <div v-show="t.showThink" class="ask-think-b">{{ t.think }}</div>
            </div>
            <div v-if="t.trace && t.trace.length" class="ask-trace">
              <span v-for="(g, k) in t.trace" :key="k" class="ask-trace-i">{{ g }}</span>
            </div>
            <p v-if="t.streaming && !t.a" class="ask-none">正在翻你的笔记…</p>
            <div class="ask-text" v-html="rich(splitOutside(t.a).inside, t.used)"></div>
            <div v-if="splitOutside(t.a).outside" class="ask-outside">
              <div class="ask-outside-tip">AI 的外部知识，不是你笔记里的内容</div>
              <div class="ask-text" v-html="rich(splitOutside(t.a).outside, [])"></div>
            </div>
            <span v-if="t.streaming" class="ask-caret">▍</span>
            <p v-if="!t.streaming && t.fallback" class="ask-none">
              库里没找到直接相关的笔记，上面是按最近更新的几篇答的
            </p>
            <p v-if="!t.streaming && t.strict" class="ask-none">只查了你的笔记</p>
            <div v-if="!t.streaming && t.used.length" class="ask-src">
              <button v-for="(s, k) in t.used" :key="s.id" class="ask-chip" @click="jump(s.id)">
                <span class="ask-chip-n">{{ k + 1 }}</span>{{ s.title }}
              </button>
            </div>
            <template v-if="!t.streaming">
              <button v-if="!saving || saving.idx !== i" class="ask-save" @click="openSave(i)">
                ＋ 存成笔记
              </button>

              <AiSavePanel
                v-else
                :saving="saving"
                :turn="t"
                @close="saving = null"
                @retry="analyze(saving.idx)"
                @save="doSave"
              />
            </template>
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
