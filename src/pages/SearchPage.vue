<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { searchNotes, domainById, topicById } from '../lib/store.js'

const route = useRoute()
const router = useRouter()
const q = computed(() => (route.query.q || '').toString())
const hits = computed(() => searchNotes(q.value))

const go = (id) => router.push(`/n/${id}`)
const path = (note) => {
  const t = topicById(note.topicId)
  return t ? `${domainById(t.domainId).name} / ${t.name}` : '未归类'
}
</script>

<template>
  <section class="page">
    <h1 class="page-title">搜索</h1>
    <p class="page-sub">“{{ q }}” · {{ hits.length }} 条结果</p>

    <div v-if="!hits.length" class="empty-state"><p>没有匹配的笔记。</p></div>

    <div class="agg-list">
      <div v-for="h in hits" :key="h.note.id" class="agg-item clickable" @click="go(h.note.id)">
        <div class="agg-main">
          <strong>{{ h.note.title }}</strong>
          <span>{{ h.ctx }}</span>
        </div>
        <div class="agg-src">{{ path(h.note) }}</div>
      </div>
    </div>
  </section>
</template>
