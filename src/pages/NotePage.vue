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
  newBlockId,
  noteBadges,
  insertBlocks,
} from '../lib/store.js'
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
watch(mode, (m) => localStorage.setItem('myknowledge.mode', m))

const savedAt = ref('')
const saving = ref(false)
let timer = null
watch(
  () => (note.value ? [note.value.title, note.value.tags, JSON.stringify(note.value.blocks)] : []),
  () => {
    if (!note.value) return
    saving.value = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      touchNote(note.value)
      saving.value = false
      savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }, 700)
  },
)

const setTags = (v) => {
  note.value.tags = v
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

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
  touchMq = window.matchMedia('(hover: none), (pointer: coarse)')
  syncTouch()
  touchMq.addEventListener?.('change', syncTouch)
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  touchMq?.removeEventListener?.('change', syncTouch)
})

const applyAi = ({ action, blocks }) => {
  if (!aiTarget.value) return
  const clean = blocks.map((b) => {
    const { section, ...rest } = b
    return rest
  })
  if (action.mode === 'insert') insertIntoSection(action.target, clean)
  else note.value.blocks.splice(aiTarget.value.index, 1, ...clean)
  aiTarget.value = null
}

const del = () => {
  if (!confirm('删除这篇笔记？原型阶段无法恢复。')) return
  const t = note.value.topicId
  removeNote(note.value.id)
  router.push(`/t/${t}`)
}
</script>

<template>
  <section v-if="note" class="page note-page">
    <nav class="crumb">
      <RouterLink to="/">知识库</RouterLink> /
      <RouterLink :to="`/d/${domain.id}`">{{ domain.name }}</RouterLink> /
      <template v-for="(p, i) in path" :key="p.id">
        <RouterLink :to="`/t/${p.id}`">{{ p.name }}</RouterLink>
        <span v-if="i < path.length - 1"> / </span>
      </template>
    </nav>

    <div class="note-head">
      <input v-if="mode === 'edit'" v-model="note.title" class="note-title-inp" />
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
        <button class="btn-ghost danger" @click="del">删除</button>
      </div>
      <p v-if="mode !== 'edit'" class="dbl-tip">
        {{ isTouch ? '点每块右上角的 ✎ 就能改那一块' : '双击正文里任意一块，直接改那一块' }}
      </p>
    </div>

    <p class="note-meta">
      <span v-if="saving" class="warn">正在保存…</span>
      <span v-else-if="savedAt">已保存 {{ savedAt }}</span>
      <span>v{{ note.version }}</span>
      <span v-if="noteBadges(note).qa" class="chip">问答 {{ noteBadges(note).qa }}</span>
      <span v-if="noteBadges(note).pitfalls" class="chip">坑 {{ noteBadges(note).pitfalls }}</span>
      <span v-if="noteBadges(note).todos" class="chip warn">待补 {{ noteBadges(note).todos }}</span>
    </p>

    <div v-if="mode === 'edit'" class="tag-row">
      <span class="adder-label">标签</span>
      <input
        class="inp inp-mini"
        :value="(note.tags || []).join(', ')"
        placeholder="CUPED, 协变量调整"
        @change="setTags($event.target.value)"
      />
      <span class="muted">同子分类内用标签切片，不必再加一层目录</span>
    </div>

    <template v-if="mode === 'edit'">
      <p class="ed-tip">
        两条轴别混：<strong>段落是叙事位置</strong>（你在论证的哪一步），<strong>块是信息形态</strong>（这条知识长什么样）。
        同一个概念卡，解释「是什么」就放核心结论段，支撑「凭什么」就放推导段。点分区末尾的 + 决定它落在哪一段；
        小节可以自己加、自己删、整节上下挪。公式懒得手打就截图按 <kbd>Ctrl</kbd>+<kbd>V</kbd>，识别完核对再插。
        阅读态里<strong>双击任何一块</strong>就跳到这一块的编辑框。
      </p>
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
          <span class="muted">小节就是二级标题；不想要的节点标题那行的 × 删掉</span>
        </div>
      </div>
    </template>

    <article v-else class="blocks">
      <div
        v-for="b in visibleBlocks"
        :key="b.id"
        class="rd-block"
        :class="{ 'is-touch': isTouch }"
        :title="isTouch ? '点右上角 ✎ 改这一块' : '双击改这一块'"
        @dblclick="editAt(b.id)"
      >
        <BlockView :block="b" />
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
