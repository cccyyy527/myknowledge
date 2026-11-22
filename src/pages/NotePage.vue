<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  state,
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
  () => (note.value ? [note.value.title, JSON.stringify(note.value.blocks)] : []),
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

const QUICK_TYPES = ['definition', 'formula', 'qa', 'pitfall', 'todo']
const visibleBlocks = computed(() => {
  if (!note.value) return []
  if (mode.value !== 'quick') return note.value.blocks
  return note.value.blocks.filter((b) => QUICK_TYPES.includes(b.type) || b.type === 'heading')
})

const ADD = [
  ['definition', '概念卡', { term: '', text: '', detail: '' }],
  ['formula', '公式卡', { latex: '', text: '' }],
  ['comparison', '对比卡', { left: '方案 A', right: '方案 B', rows: [{ k: '', a: '', b: '' }] }],
  ['qa', '问答卡', { question: '', answer: '' }],
  ['pitfall', '坑卡', { text: '', cause: '', avoid: '' }],
  ['steps', '步骤卡', { text: '', items: [''] }],
  ['callout', '提示', { tone: 'tip', text: '' }],
  ['bulletList', '列表', { items: [''] }],
  ['heading', '小节标题', { level: 2, text: '' }],
  ['paragraph', '段落', { text: '' }],
  ['code', '代码', { text: '' }],
  ['todo', '待补', { text: '' }],
]

const addBlock = (type) => {
  const def = ADD.find((a) => a[0] === type)
  if (!def || !note.value) return
  note.value.blocks.push({ id: newBlockId(), type, ...structuredClone(def[2]) })
  mode.value = 'edit'
}

const moveBlock = (i, delta) => {
  const arr = note.value.blocks
  const j = i + delta
  if (j < 0 || j >= arr.length) return
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

    <article class="blocks">
      <template v-if="mode === 'edit'">
        <BlockEdit
          v-for="(b, i) in note.blocks"
          :key="b.id"
          :block="b"
          :index="i"
          @remove="removeBlock(i)"
          @move="(d) => moveBlock(i, d)"
        />
        <div class="adder">
          <span class="adder-label">插入块</span>
          <button v-for="a in ADD" :key="a[0]" class="chip-btn" @click="addBlock(a[0])">
            + {{ a[1] }}
          </button>
        </div>
      </template>

      <template v-else>
        <BlockView v-for="b in visibleBlocks" :key="b.id" :block="b" />
        <p v-if="mode === 'quick' && visibleBlocks.length <= 1" class="muted">
          这篇还没有概念 / 公式 / 问答 / 坑卡片。
        </p>
      </template>
    </article>
  </section>
  <p v-else class="page">找不到这篇笔记</p>
</template>
