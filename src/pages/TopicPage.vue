<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  topicById,
  topicPath,
  childrenOf,
  domainById,
  notesOfSubtree,
  topicStats,
  noteBadges,
  noteSummary,
  createNote,
} from '../lib/store.js'

const route = useRoute()
const router = useRouter()
const topic = computed(() => topicById(route.params.topicId))
const path = computed(() => (topic.value ? topicPath(topic.value.id) : []))
const domain = computed(() => (topic.value ? domainById(topic.value.domainId) : null))
const kids = computed(() => (topic.value ? childrenOf(topic.value.id) : []))
const all = computed(() => (topic.value ? notesOfSubtree(topic.value.id) : []))

const activeTag = ref('')
const tags = computed(() => {
  const set = new Set()
  all.value.forEach((n) => (n.tags || []).forEach((t) => set.add(t)))
  return [...set]
})
const notes = computed(() =>
  activeTag.value ? all.value.filter((n) => (n.tags || []).includes(activeTag.value)) : all.value,
)

const add = () => {
  const n = createNote(route.params.topicId)
  router.push(`/n/${n.id}`)
}

const nameOf = (topicId) => topicById(topicId)?.name || '未归类'

const ago = (iso) => {
  if (!iso) return ''
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
      <RouterLink :to="`/d/${domain.id}`">{{ domain.name }}</RouterLink> /
      <template v-for="(p, i) in path" :key="p.id">
        <RouterLink :to="`/t/${p.id}`">{{ p.name }}</RouterLink>
        <span v-if="i < path.length - 1"> / </span>
      </template>
    </nav>

    <div class="title-row">
      <h1 class="page-title">{{ topic.name }}</h1>
      <button class="btn" @click="add">+ 新建笔记</button>
    </div>
    <p class="muted topic-hint">
      <template v-if="kids.length">
        这一层是分组，共 {{ kids.length }} 个细分。真正写笔记的地方是细分层；这里会汇总全部下级笔记。
      </template>
      <template v-else>
        一篇笔记 = 一个知识点（如 CUPED / 分层抽样 / 回归调整）。同主题内容再多也不加层级，用标签切片。
      </template>
    </p>

    <template v-if="kids.length">
      <div class="grid topic-grid">
        <RouterLink
          v-for="k in kids"
          :key="k.id"
          :to="`/t/${k.id}`"
          class="card topic-card"
          :class="{ empty: topicStats(k.id).all === 0 }"
        >
          <h4>
            {{ k.name }}
            <span v-if="topicStats(k.id).kids" class="kids">
              {{ topicStats(k.id).kids }} 子类
            </span>
          </h4>
          <div class="card-meta">
            <span v-if="topicStats(k.id).all">{{ topicStats(k.id).all }} 篇</span>
            <span v-else class="muted">+ 从这里开始</span>
            <span v-if="topicStats(k.id).todos" class="warn">待补 {{ topicStats(k.id).todos }}</span>
          </div>
        </RouterLink>
      </div>
      <h3 class="sub-h">全部笔记（含下级 {{ all.length }} 篇）</h3>
    </template>

    <div v-if="tags.length" class="tag-bar">
      <button class="chip-btn" :class="{ on: !activeTag }" @click="activeTag = ''">
        全部 {{ all.length }}
      </button>
      <button
        v-for="t in tags"
        :key="t"
        class="chip-btn"
        :class="{ on: activeTag === t }"
        @click="activeTag = activeTag === t ? '' : t"
      >
        # {{ t }}
      </button>
    </div>

    <div v-if="!notes.length" class="empty-state">
      <p>{{ kids.length ? '这一组下还没有笔记。' : '这个分类还没有笔记。' }}</p>
      <button class="btn" @click="add">先在这里写一篇</button>
    </div>

    <div class="grid note-grid">
      <RouterLink v-for="n in notes" :key="n.id" :to="`/n/${n.id}`" class="card note-card">
        <h3>{{ n.title }}<span v-if="n.pinned" class="pin">置顶</span></h3>
        <p class="card-hint">{{ noteSummary(n) }}</p>
        <div v-if="(n.tags || []).length || kids.length" class="card-tags">
          <span v-if="kids.length && n.topicId !== topic.id" class="tag sub">
            ↳ {{ nameOf(n.topicId) }}
          </span>
          <span v-for="t in n.tags" :key="t" class="tag">#{{ t }}</span>
        </div>
        <div class="card-meta">
          <span v-if="noteBadges(n).formulas">公式 {{ noteBadges(n).formulas }}</span>
          <span v-if="noteBadges(n).qa">问答 {{ noteBadges(n).qa }}</span>
          <span v-if="noteBadges(n).pitfalls">坑 {{ noteBadges(n).pitfalls }}</span>
          <span v-if="noteBadges(n).todos" class="warn">待补 {{ noteBadges(n).todos }}</span>
          <span v-if="ago(n.updatedAt)" class="muted">{{ ago(n.updatedAt) }}</span>
        </div>
      </RouterLink>
    </div>
  </section>
  <p v-else class="page">找不到这个分类</p>
</template>
