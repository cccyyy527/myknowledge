<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  topicById,
  domainById,
  notesOfTopic,
  noteBadges,
  noteSummary,
  createNote,
} from '../lib/store.js'

const route = useRoute()
const router = useRouter()
const topic = computed(() => topicById(route.params.topicId))
const domain = computed(() => (topic.value ? domainById(topic.value.domainId) : null))
const notes = computed(() => (topic.value ? notesOfTopic(topic.value.id) : []))

const add = () => {
  const n = createNote(route.params.topicId)
  router.push(`/n/${n.id}`)
}

const ago = (iso) => {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  return `${d} 天前`
}
</script>

<template>
  <section v-if="topic" class="page">
    <nav class="crumb">
      <RouterLink to="/">知识库</RouterLink> /
      <RouterLink :to="`/d/${domain.id}`">{{ domain.name }}</RouterLink> / {{ topic.name }}
    </nav>
    <div class="title-row">
      <h1 class="page-title">{{ topic.name }}</h1>
      <button class="btn" @click="add">+ 新建笔记</button>
    </div>

    <div v-if="!notes.length" class="empty-state">
      <p>这个子分类还没有笔记。</p>
      <button class="btn" @click="add">从这里开始写第一篇</button>
    </div>

    <div class="grid note-grid">
      <RouterLink v-for="n in notes" :key="n.id" :to="`/n/${n.id}`" class="card note-card">
        <h3>{{ n.title }}<span v-if="n.pinned" class="pin">置顶</span></h3>
        <p class="card-hint">{{ noteSummary(n) }}</p>
        <div class="card-meta">
          <span v-if="noteBadges(n).formulas">公式 {{ noteBadges(n).formulas }}</span>
          <span v-if="noteBadges(n).qa">问答 {{ noteBadges(n).qa }}</span>
          <span v-if="noteBadges(n).pitfalls">坑 {{ noteBadges(n).pitfalls }}</span>
          <span v-if="noteBadges(n).todos" class="warn">待补 {{ noteBadges(n).todos }}</span>
          <span class="muted">{{ ago(n.updatedAt) }}</span>
        </div>
      </RouterLink>
    </div>
  </section>
  <p v-else class="page">找不到这个子分类</p>
</template>
