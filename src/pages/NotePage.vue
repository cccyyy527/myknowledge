<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  noteById,
  topicById,
  domainById,
  touchNote,
  removeNote,
  newBlockId,
  noteBadges,
} from '../lib/store.js'
import BlockView from '../components/BlockView.vue'
import BlockEdit from '../components/BlockEdit.vue'

const route = useRoute()
const router = useRouter()
const note = computed(() => noteById(route.params.noteId))
const topic = computed(() => (note.value ? topicById(note.value.topicId) : null))
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
  ['todo', '待补', { text: '' }],
]

const addBlock = (type, section) => {
  const def = ADD.find((a) => a[0] === type)
  if (!def || !note.value) return
  const blocks = note.value.blocks
  let at
  if (!section.heading) at = 0
  else if (section.items.length) at = section.items[section.items.length - 1].index + 1
  else at = section.heading.index + 1
  blocks.splice(at, 0, { id: newBlockId(), type, ...structuredClone(def[2]) })
}

const moveBlock = (i, delta) => {
  const arr = note.value.blocks
  const j = i + delta
  if (j < 0 || j >= arr.length) return
  if (arr[j].type === 'heading') return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

const removeBlock = (i) => note.value.blocks.splice(i, 1)

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
      <RouterLink :to="`/t/${topic.id}`">{{ topic.name }}</RouterLink>
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
        <button class="btn-ghost danger" @click="del">删除</button>
      </div>
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
        四段骨架不可改。新知识按<strong>形态</strong>加进对应分区：术语→概念、算式→公式、两者之差→对比、
        面试官会问的→问答、自己错过的→坑。分区末尾的 + 决定它落在哪一段。
      </p>
      <div class="blocks">
        <section v-for="(sec, si) in sections" :key="si" class="ed-section">
          <BlockEdit
            v-if="sec.heading"
            :block="sec.heading.block"
            :deletable="false"
            @move="(d) => moveBlock(sec.heading.index, d)"
          />
          <BlockEdit
            v-for="it in sec.items"
            :key="it.block.id"
            :block="it.block"
            @remove="removeBlock(it.index)"
            @move="(d) => moveBlock(it.index, d)"
          />
          <div class="adder">
            <span class="adder-label">在此段加</span>
            <button v-for="a in ADD" :key="a[0]" class="chip-btn" @click="addBlock(a[0], sec)">
              + {{ a[1] }}
            </button>
          </div>
        </section>
      </div>
    </template>

    <article v-else class="blocks">
      <BlockView v-for="b in visibleBlocks" :key="b.id" :block="b" />
      <p v-if="mode === 'quick' && visibleBlocks.length <= 1" class="muted">
        这篇还没有概念 / 公式 / 问答 / 坑卡片。
      </p>
    </article>
  </section>
  <p v-else class="page">找不到这篇笔记</p>
</template>
