<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  noteById,
  topicById,
  topicPath,
  domainById,
  touchNote,
  removeNote,
  moveNote,
  renameNote,
  liveNotes,
  newBlockId,
  noteBadges,
  insertBlocks,
  createNote,
  flattenTopics,
  state,
} from '../lib/store.js'
import { backlinksTo, brokenLinks } from '../lib/links.js'
import BlockView from '../components/BlockView.vue'
import BlockEdit from '../components/BlockEdit.vue'
import AiBlockDialog from '../components/AiBlockDialog.vue'
import AiNoteDialog from '../components/AiNoteDialog.vue'
import OcrDialog from '../components/OcrDialog.vue'

const route = useRoute()
const router = useRouter()
const note = computed(() => noteById(route.params.noteId))
const topic = computed(() => (note.value ? topicById(note.value.topicId) : null))
const path = computed(() => (topic.value ? topicPath(topic.value.id) : []))
const domain = computed(() => (topic.value ? domainById(topic.value.domainId) : null))

const mode = ref(localStorage.getItem('myknowledge.mode') || 'read')

/* ---------- 切换模式时怎么处理滚动位置 ----------
   顶部 tab 切：按用户要求回页面顶端（两种模式排版高度差近一倍，硬记像素必然错位）。
   右下角浮动按钮切：原地不动 —— 按「当前看着的那一块」记位置，切完把同一块对回屏幕原位。
   双击进编辑 / 新增小节 / 识图落块这类自己会定位的入口：都不动。 */
let skipAnchor = false // 入口自己会定位
let holdPos = false // 保住当前位置

// 记「视口顶端那块」的 id 和块内相对位置（0 = 块顶贴顶，1 = 块底贴顶）
const grabPos = () => {
  const els = [...document.querySelectorAll('[data-bid]')]
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.bottom > 0 && r.height > 0) {
      const ratio = Math.min(1, Math.max(0, -r.top / r.height))
      return { id: el.dataset.bid, ratio, y: r.top + ratio * r.height }
    }
  }
  return null
}

const restorePos = (p) => {
  const el = p ? document.querySelector(`[data-bid="${p.id}"]`) : null
  if (!el) return window.scrollTo(0, 0)
  const r = el.getBoundingClientRect()
  window.scrollBy(0, r.top + p.ratio * r.height - p.y)
}

watch(mode, (m) => {
  localStorage.setItem('myknowledge.mode', m)
  const skip = skipAnchor
  const hold = holdPos
  skipAnchor = false
  holdPos = false
  if (skip) return
  if (!hold) return nextTick(() => window.scrollTo(0, 0))
  const p = grabPos() // 此时 DOM 还没换，拿到的还是旧排版
  nextTick(() => restorePos(p))
})

const fabToggle = () => {
  holdPos = true
  mode.value = mode.value === 'edit' ? 'read' : 'edit'
}

const savedAt = ref('')
const saving = ref(false)
let timer = null

/* ---------- 滚下去以后不用再滑回顶部切模式 ---------- */
const fabOn = ref(false)
const syncFab = () => {
  fabOn.value = window.scrollY > 240
}
// 老数据可能没有 tags 字段，编辑态要往里 push，先补齐
watch(
  note,
  (n) => {
    if (n && !Array.isArray(n.tags)) n.tags = []
  },
  { immediate: true },
)
// 只按「内容签名」判断要不要存：切模式、加空格子这类不改内容的操作不触发
const editSig = computed(() =>
  note.value
    ? [
        note.value.title || '',
        JSON.stringify(note.value.tags || []),
        JSON.stringify(note.value.blocks || []),
      ].join('\u0001')
    : '',
)
watch(editSig, () => {
  if (!note.value) return
  saving.value = true
  clearTimeout(timer)
  timer = setTimeout(() => {
    touchNote(note.value)
    saving.value = false
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }, 700)
})

// 标签一个一格：失焦时把空格子和空标签清掉
const compactTags = () => {
  if (!note.value) return
  const next = (note.value.tags || []).map((t) => String(t || '').trim()).filter(Boolean)
  const cur = note.value.tags || []
  const same = next.length === cur.length && next.every((t, i) => t === cur[i])
  if (!same) note.value.tags = next
}

// 标签格子跟着字长走：中文按两格算，别让一格占掉半行
const tagWidth = (t) => {
  let w = 0
  for (const ch of String(t || '')) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return `${Math.min(14, Math.max(4, w + 2))}ch`
}

// 阅读态把标签也显示出来：去掉空标签和重复
const readTags = computed(() => {
  const seen = new Set()
  return (note.value?.tags || [])
    .map((t) => String(t || '').trim())
    .filter((t) => t && !seen.has(t) && seen.add(t))
})

const SECTION_HINTS = {
  核心结论: '只放断言：一句能被追问「凭什么」的话，带关键数字。名词解释用概念卡，别拿定义当结论。',
  '推导 / 细节': '支撑上面那句断言的东西：公式、成立的前提、无偏性、和替代方案比。',
  高频问法: '面试官的原话 + 你的答法。别写「可能被问到…」，那不是问法。',
  我踩过的坑: '你真答错过、做错过的事，加怎么改。没踩过就空着。',
  待补: '还没查清的先占位，别硬凑结论。',
}
const hintOf = (sec) => (sec.heading ? SECTION_HINTS[sec.heading.block.text] || '' : '')
const QUICK_TYPES = ['definition', 'formula', 'qa', 'pitfall', 'todo']
const visibleBlocks = computed(() => {
  if (!note.value) return []
  if (mode.value !== 'quick') return note.value.blocks
  return note.value.blocks.filter((b) => QUICK_TYPES.includes(b.type) || b.type === 'heading')
})

// 四段骨架固定；其余块按 heading 归入所在分区，新块只会落到“想放的那一段”
const sections = computed(() => {
  const out = []
  let cur = { heading: null, items: [] }
  const blocks = note.value ? note.value.blocks : []
  blocks.forEach((b, i) => {
    if (b.type === 'heading' && b.level === 2) {
      if (cur.heading || cur.items.length) out.push(cur)
      cur = { heading: { block: b, index: i }, items: [] }
    } else {
      cur.items.push({ block: b, index: i })
    }
  })
  if (cur.heading || cur.items.length) out.push(cur)
  return out
})

const ADD = [
  ['definition', '概念', { term: '', text: '', detail: '' }],
  ['formula', '公式', { latex: '', text: '' }],
  ['comparison', '对比', { left: '方案 A', right: '方案 B', rows: [{ k: '', a: '', b: '' }] }],
  ['qa', '问答', { question: '', answer: '' }],
  ['pitfall', '坑', { text: '', cause: '', avoid: '' }],
  ['steps', '步骤', { text: '', items: [''] }],
  ['callout', '提示', { tone: 'tip', text: '' }],
  ['bulletList', '列表', { items: [''] }],
  ['paragraph', '段落', { text: '' }],
  ['code', '代码', { text: '' }],
  ['image', '图片', { src: '', text: '' }],
  ['todo', '待补', { text: '' }],
]

// 段尾插入位置：有块就接在最后一个块后面，空段就接在标题后面
const sectionEndAt = (section) => {
  const blocks = note.value.blocks
  if (!section) return blocks.length
  if (section.items.length) return Math.min(section.items[section.items.length - 1].index + 1, blocks.length)
  if (section.heading) return Math.min(section.heading.index + 1, blocks.length)
  return blocks.length
}

const spliceAtSectionEnd = (section, patch) => {
  if (!note.value) return
  note.value.blocks.splice(sectionEndAt(section), 0, { id: newBlockId(), ...patch })
}

const addBlock = (type, section) => {
  const def = ADD.find((a) => a[0] === type)
  if (!def || !note.value) return
  spliceAtSectionEnd(section, { type, ...structuredClone(def[2]) })
}

const moveBlock = (i, delta) => {
  const arr = note.value.blocks
  const j = i + delta
  if (j < 0 || j >= arr.length) return
  if (arr[j].type === 'heading') return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

const removeBlock = (i) => note.value.blocks.splice(i, 1)

/* ---------- 在任意两块之间插内容（两节之间就是从下一节标题前面插） ---------- */
// 点某块的「＋」，先记下插入点，再在面板里选要插什么
const insertAt = ref(null)
// 默认插在这块前面；面板上可以改成后面 —— 想在 A、B 两块中间插，点 A 选「后面」或点 B 选「前面」都行
const insertSide = ref('before')

const openInsert = (index) => {
  insertSide.value = 'before'
  insertAt.value = index
}

const blockLabel = (b) => {
  if (!b) return '这一块'
  if (b.type === 'heading') return '小节标题'
  return ADD.find((a) => a[0] === b.type)?.[1] || b.type
}

const insertWhere = computed(() => {
  const b = note.value?.blocks?.[insertAt.value]
  const name = b?.text ? `「${String(b.text).slice(0, 12)}」` : `「${blockLabel(b)}」`
  return `插在${name}${insertSide.value === 'after' ? '后面' : '前面'}`
})

const insertPos = () => insertAt.value + (insertSide.value === 'after' ? 1 : 0)

const insertBlockBefore = (type) => {
  const def = ADD.find((a) => a[0] === type)
  if (!def || !note.value || insertAt.value === null) return
  const b = { id: newBlockId(), type, ...structuredClone(def[2]) }
  note.value.blocks.splice(insertPos(), 0, b)
  insertAt.value = null
  nextTick(() => focusBlock(b.id))
}

const insertSectionBefore = () => {
  if (!note.value || insertAt.value === null) return
  const b = { id: newBlockId(), type: 'heading', level: 2, text: '' }
  note.value.blocks.splice(insertPos(), 0, b)
  insertAt.value = null
  nextTick(() => focusBlock(b.id))
}

/* ---------- 小节：增 / 删 / 整节上下移 ---------- */
// 触屏没有双击：给每块挂一个点得到的 ✎
const isTouch = ref(false)
let touchMq = null
const syncTouch = () => {
  isTouch.value = touchMq ? touchMq.matches : false
}

const focusBlock = (id) => {
  const row = document.querySelector(`.ed-row[data-bid="${id}"]`)
  const inp = row && row.querySelector('input, textarea, select')
  if (!inp) return
  // 手机上键盘会盖住下半屏，先把块滚到中间再聚焦
  if (isTouch.value) inp.scrollIntoView({ block: 'center' })
  inp.focus()
  if (inp.value && typeof inp.setSelectionRange === 'function') {
    inp.setSelectionRange(inp.value.length, inp.value.length)
  }
}

const addSection = (afterSec = null) => {
  if (!note.value) return
  const b = { id: newBlockId(), type: 'heading', level: 2, text: '' }
  note.value.blocks.splice(afterSec ? sectionEndAt(afterSec) : note.value.blocks.length, 0, b)
  skipAnchor = mode.value !== 'edit' // 这个入口自己会把新小节滚到眼前，别又拉回顶端
  mode.value = 'edit'
  nextTick(() => focusBlock(b.id))
}

const removeSection = (sec) => {
  if (!note.value || !sec?.heading) return
  const from = sec.heading.index
  const end = sectionEndAt(sec)
  const n = end - from - 1
  const title = sec.heading.block.text || '未命名小节'
  if (n > 0 && !confirm(`删掉「${title}」这一节？里面的 ${n} 个块会一起删掉。`)) return
  note.value.blocks.splice(from, end - from)
}

const moveSection = (sec, delta) => {
  if (!note.value) return
  const groups = sections.value.map((s) => note.value.blocks.slice(s.heading ? s.heading.index : 0, sectionEndAt(s)))
  const i = sections.value.indexOf(sec)
  const j = i + delta
  if (i < 0 || j < 0 || j >= groups.length) return
  const [g] = groups.splice(i, 1)
  groups.splice(j, 0, g)
  note.value.blocks.splice(0, note.value.blocks.length, ...groups.flat())
}

/* ---------- 阅读 / 速查态双击直接改这一块 ---------- */
const editAt = (blockId) => {
  if (mode.value !== 'edit') skipAnchor = true // focusBlock 自己会定位到这一块
  mode.value = 'edit'
  nextTick(() => focusBlock(blockId))
}

/* ---------- AI 改写单块 ---------- */
const aiTarget = ref(null) // { index, block, sectionTitle }
const wholeAi = ref(false)

const sectionTitleOf = (index) => {
  const blocks = note.value?.blocks || []
  for (let i = index; i >= 0; i--) {
    if (blocks[i].type === 'heading' && blocks[i].level === 2) return blocks[i].text
  }
  return ''
}

const openAi = (index) => {
  const b = note.value.blocks[index]
  aiTarget.value = { index, block: b, sectionTitle: sectionTitleOf(index) }
}

// 插到某个段落的末尾；没有这一段就在文末新起一段
const insertIntoSection = (title, blocks) => insertBlocks(note.value, title, blocks)

// 识图结果落在当前块下一格
const insertAfter = (index, patch) => {
  if (!note.value || !patch) return
  note.value.blocks.splice(index + 1, 0, { id: newBlockId(), ...patch })
}

/* ---------- 识图：截图 → 公式 / 段落 ---------- */
const ocrOpen = ref(false)
const ocrSrc = ref('')
const ocrSec = ref(null)

// 光标在哪一段里，就往哪一段末尾插；找不到就退回第一段
const secAtFocus = () => {
  const el = document.activeElement
  const box = el && typeof el.closest === 'function' ? el.closest('.ed-section') : null
  const si = box ? Number(box.dataset.si) : NaN
  return Number.isInteger(si) ? sections.value[si] || null : null
}

const openOcr = (section = null, src = '') => {
  ocrSec.value = section || secAtFocus() || sections.value[0] || null
  ocrSrc.value = src
  ocrOpen.value = true
}

const ocrWhere = computed(() => {
  const t = ocrSec.value?.heading?.block?.text
  return t ? `「${t}」这段的末尾` : '文末'
})

const applyOcr = (patch) => {
  if (!patch) return
  spliceAtSectionEnd(ocrSec.value, patch)
  if (mode.value !== 'edit') skipAnchor = true // 刚插进来的块在中间，别跳到顶端
  mode.value = 'edit'
}

// 编辑态下随便哪个输入框里按 Ctrl+V 粘截图，都直接进识图
const pasteImage = (e) =>
  [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file' && String(it.type).startsWith('image/'))
    .map((it) => it.getAsFile())
    .find(Boolean)

const onPaste = (e) => {
  if (mode.value !== 'edit' || ocrOpen.value || !note.value) return
  const f = pasteImage(e)
  if (!f) return
  e.preventDefault()
  openOcr(null, f)
}

onMounted(() => {
  window.addEventListener('paste', onPaste)
  window.addEventListener('scroll', syncFab, { passive: true })
  syncFab()
  touchMq = window.matchMedia('(hover: none), (pointer: coarse)')
  syncTouch()
  touchMq.addEventListener?.('change', syncTouch)
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('scroll', syncFab)
  touchMq?.removeEventListener?.('change', syncTouch)
})

const applyAi = ({ action, blocks }) => {
  if (!aiTarget.value) return
  const clean = blocks.map((b) => {
    const { section, ...rest } = b
    return rest
  })
  if (action.mode === 'insert' && action.target) insertIntoSection(action.target, clean)
  else if (action.mode === 'insert') note.value.blocks.splice(aiTarget.value.index + 1, 0, ...clean)
  else note.value.blocks.splice(aiTarget.value.index, 1, ...clean)
  aiTarget.value = null
}

const del = () => {
  if (!confirm('删除这篇笔记？会先进回收站，之后能捞回来。')) return
  const t = note.value.topicId
  removeNote(note.value.id)
  router.push(t ? `/t/${t}` : '/orphans')
}

/* ---------- 换分类：写错地方不用删了重写 ---------- */
const moveOpen = ref(false)
const moveTo = ref('')
const moveGroups = computed(() =>
  state.domains.map((d) => ({ domain: d, rows: flattenTopics(d.id, true) })).filter((g) => g.rows.length),
)
const openMove = () => {
  moveTo.value = note.value.topicId || ''
  moveOpen.value = true
}
const doMove = () => {
  const t = moveTo.value
  if (!t || t === note.value.topicId) {
    moveOpen.value = false
    return
  }
  if (!moveNote(note.value.id, t)) return
  moveOpen.value = false
  const name = topicPath(t).map((x) => x.name).join(' / ')
  savedAt.value = `已移到 ${name}`
}

// 问答卡里的 [1] 引用 chip：目标是另一篇还在的笔记才跳
const openRef = (id) => {
  if (!id || id === note.value.id || !noteById(id)) return
  router.push(`/n/${id}`)
}

// 点了「未创建」的 [[标题]]：就地按这个标题建一篇，挂在当前笔记同一个子分类下
const makeNote = (title) => {
  const t = String(title || '').trim()
  if (!t || !note.value) return
  const made = createNote(note.value.topicId)
  made.title = t
  touchNote(made)
  router.push(`/n/${made.id}`)
}

const backlinks = computed(() => backlinksTo(note.value?.id, liveNotes()))

/* ---------- 改标题 ----------
   输入框不直接绑 note.title：中间留一层草稿，提交时才落地，
   这样能在同一个动作里把指向旧标题的老链接一起换成 id 链接，不再静默断链。 */
const titleDraft = ref('')
watch(
  () => note.value?.title,
  (t) => {
    titleDraft.value = t || ''
  },
  { immediate: true },
)

const commitTitle = () => {
  const n = note.value
  if (!n) return
  const next = String(titleDraft.value || '').trim()
  if (!next || next === n.title) {
    titleDraft.value = n.title
    return
  }
  const r = renameNote(n.id, next)
  savedAt.value = r.refs ? `已改名，${r.refs} 处旧链接一起跟过来了` : '已改名'
}

// 这篇自己正文里指向不存在目标的 [[ ]]，给个提示而不是悄悄变灰
const brokenHere = computed(() => {
  const id = note.value?.id
  if (!id) return []
  return brokenLinks(liveNotes())
    .filter((b) => b.note.id === id)
    .map((b) => b.link)
})

</script>

<template>
  <section v-if="note" class="page note-page">
    <nav class="crumb">
      <RouterLink to="/">知识库</RouterLink> /
      <template v-if="domain">
        <RouterLink :to="`/d/${domain.id}`">{{ domain.name }}</RouterLink> /
        <template v-for="(p, i) in path" :key="p.id">
          <RouterLink :to="`/t/${p.id}`">{{ p.name }}</RouterLink>
          <span v-if="i < path.length - 1"> / </span>
        </template>
      </template>
      <RouterLink v-else to="/orphans" class="crumb-orphan">失去归属的笔记</RouterLink>
    </nav>

    <div class="note-head">
      <input
        v-if="mode === 'edit'"
        v-model="titleDraft"
        class="note-title-inp"
        title="改完按 Enter 或点别处生效，指向这篇的老链接会一起跟过来"
        @blur="commitTitle"
        @keyup.enter="$event.target.blur()"
      />
      <h1 v-else class="page-title">{{ note.title }}</h1>
      <div class="note-tools">
        <div class="tabs">
          <button :class="{ on: mode === 'read' }" @click="mode = 'read'">阅读</button>
          <button :class="{ on: mode === 'edit' }" @click="mode = 'edit'">编辑</button>
          <button :class="{ on: mode === 'quick' }" @click="mode = 'quick'">速查</button>
        </div>
        <button class="btn-ghost" title="让 AI 重排整篇" @click="wholeAi = true">
          ✨ 整篇助手
        </button>
        <button class="btn-ghost" title="换到别的分类下" @click="moveOpen ? (moveOpen = false) : openMove()">
          ⇄ 换分类
        </button>
        <button class="btn-ghost danger" @click="del">删除</button>
      </div>
    </div>

    <div v-if="moveOpen" class="move-row">
      <span class="adder-label">移到</span>
      <select v-model="moveTo" class="inp move-sel">
        <option value="" disabled>选一个分类</option>
        <optgroup v-for="g in moveGroups" :key="g.domain.id" :label="g.domain.name">
          <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
            {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
          </option>
        </optgroup>
      </select>
      <button class="btn" :disabled="!moveTo || moveTo === note.topicId" @click="doMove">移到这里</button>
      <button class="btn-ghost" @click="moveOpen = false">取消</button>
    </div>

    <p class="note-meta">
      <span v-if="saving" class="warn">正在保存…</span>
      <span v-else-if="savedAt">已保存 {{ savedAt }}</span>
      <span v-if="noteBadges(note).qa" class="chip">问答 {{ noteBadges(note).qa }}</span>
      <span v-if="noteBadges(note).pitfalls" class="chip">坑 {{ noteBadges(note).pitfalls }}</span>
      <span v-if="noteBadges(note).todos" class="chip warn">待补 {{ noteBadges(note).todos }}</span>
      <span v-if="brokenHere.length" class="chip warn" :title="brokenHere.map((l) => l.target).join('、')">
        {{ brokenHere.length }} 个链接指不到东西
      </span>
    </p>

    <div v-if="mode !== 'edit' && readTags.length" class="tag-read">
      <span class="adder-label">标签</span>
      <span v-for="t in readTags" :key="t" class="tag">#{{ t }}</span>
    </div>

    <div v-if="mode === 'edit'" class="tag-row">
      <span class="adder-label">标签</span>
      <span v-for="(t, i) in note.tags" :key="i" class="tag-edit">
        <input
          v-model="note.tags[i]"
          class="inp tag-inp"
          placeholder="标签名"
          :style="{ width: tagWidth(t) }"
          @blur="compactTags"
          @keyup.enter="$event.target.blur()"
        />
        <button class="tag-del" title="删掉这个标签" @click="note.tags.splice(i, 1)">×</button>
      </span>
      <button class="chip-btn" title="一个标签一格" @click="note.tags.push('')">+ 标签</button>
      <span class="muted">同子分类内用标签切片，不必再加一层目录</span>
    </div>

    <template v-if="mode === 'edit'">
      <div class="blocks">
        <section
          v-for="(sec, si) in sections"
          :key="si"
          class="ed-section"
          :data-si="si"
        >
          <BlockEdit
            v-if="sec.heading"
            :block="sec.heading.block"
            @remove="removeSection(sec)"
            @move="(d) => moveSection(sec, d)"
            @insert-before="openInsert(sec.heading.index)"
          />
          <p v-if="hintOf(sec)" class="sec-hint">{{ hintOf(sec) }}</p>
          <BlockEdit
            v-for="it in sec.items"
            :key="it.block.id"
            :block="it.block"
            @remove="removeBlock(it.index)"
            @move="(d) => moveBlock(it.index, d)"
            @ai="openAi(it.index)"
            @insert="insertAfter(it.index, $event)"
            @insert-before="openInsert(it.index)"
          />
          <div class="adder">
            <span class="adder-label">在此段加</span>
            <button v-for="a in ADD" :key="a[0]" class="chip-btn" @click="addBlock(a[0], sec)">
              + {{ a[1] }}
            </button>
            <button class="chip-btn" title="截图 → 公式，不用手打" @click="openOcr(sec)">
              📷 识图
            </button>
            <button class="chip-btn" title="在这一节后面新起一节" @click="addSection(sec)">
              ⁝ 新小节
            </button>
          </div>
        </section>

        <div class="ed-section-add">
          <button class="chip-btn" @click="addSection(null)">+ 在文末新起一节</button>
          <span class="muted">
            小节就是二级标题；不想要的节点标题那行的 × 删掉。要在两块之间插，点上面那块的 ＋ 选「插在后面」（或下面那块的 ＋ 选「插在前面」）
          </span>
        </div>
      </div>
    </template>

    <article v-else class="blocks">
      <div
        v-for="b in visibleBlocks"
        :key="b.id"
        class="rd-block"
        :class="{ 'is-touch': isTouch }"
        :data-bid="b.id"
        @dblclick="editAt(b.id)"
      >
        <BlockView :block="b" @open-note="openRef" @make-note="makeNote" />
        <button
          v-if="isTouch"
          class="rd-edit"
          title="改这一块"
          @click.stop="editAt(b.id)"
        >
          ✎
        </button>
      </div>
      <p v-if="mode === 'quick' && visibleBlocks.length <= 1" class="muted">
        这篇还没有概念 / 公式 / 问答 / 坑卡片。
      </p>
    </article>

    <section v-if="mode !== 'edit' && backlinks.length" class="backlinks">
      <h3 class="bl-title">被引用</h3>
      <p class="muted bl-hint">别的笔记正文里写了 [[{{ note.title }}]] 的地方</p>
      <button
        v-for="b in backlinks"
        :key="b.from"
        class="bl-item"
        @click="router.push(`/n/${b.from}`)"
      >
        <span class="bl-from">{{ b.title }}</span>
        <span v-if="b.snippet" class="bl-snip">{{ b.snippet }}</span>
      </button>
    </section>

    <button
      v-if="fabOn"
      class="mode-fab"
      :title="mode === 'edit' ? '切回阅读（停在这一块）' : '切到编辑（停在这一块）'"
      @click="fabToggle"
    >
      {{ mode === 'edit' ? '👁 阅读' : '✎ 编辑' }}
    </button>

    <div v-if="insertAt !== null" class="ins-mask" @click.self="insertAt = null">
      <div class="ins-box">
        <div class="ins-head">
          <strong>插在这里</strong>
          <span class="muted ins-where">{{ insertWhere }}</span>
          <button class="btn-ghost" @click="insertAt = null">×</button>
        </div>
        <div class="ins-side">
          <button
            class="chip-btn"
            :class="{ on: insertSide === 'before' }"
            @click="insertSide = 'before'"
          >
            插在前面
          </button>
          <button
            class="chip-btn"
            :class="{ on: insertSide === 'after' }"
            @click="insertSide = 'after'"
          >
            插在后面
          </button>
        </div>
        <div class="ins-grid">
          <button v-for="a in ADD" :key="a[0]" class="chip-btn" @click="insertBlockBefore(a[0])">
            + {{ a[1] }}
          </button>
          <button class="chip-btn" @click="insertSectionBefore">⁝ 新小节</button>
        </div>
      </div>
    </div>

    <AiBlockDialog
      :open="!!aiTarget"
      :block="aiTarget?.block"
      :note="note"
      :section-title="aiTarget?.sectionTitle || ''"
      @close="aiTarget = null"
      @apply="applyAi"
    />

    <AiNoteDialog
      :open="wholeAi"
      :note="note"
      @close="wholeAi = false"
      @applied="mode = 'edit'"
    />

    <OcrDialog
      :open="ocrOpen"
      :src="ocrSrc"
      :where="ocrWhere"
      @close="ocrOpen = false"
      @insert="applyOcr"
    />
  </section>
  <p v-else class="page">找不到这篇笔记</p>
</template>
