<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { aggregate, dropBlock, topicById, domainById } from '../lib/store.js'

const route = useRoute()

const META = {
  glossary: { title: '术语表', type: 'definition', hint: '所有概念卡汇总，跨子分类自动聚合。' },
  formulas: { title: '公式库', type: 'formula', hint: '所有公式卡，按笔记来源排列。' },
  qa: { title: '问答库', type: 'qa', hint: '高频问法汇总，之后可直接接复习调度。' },
  pitfalls: { title: '坑清单', type: 'pitfall', hint: '踩过的坑，面试前扫一遍。' },
  todos: { title: '待补清单', type: 'todo', hint: '写笔记时标下的「待补」，都在这儿等着补。' },
}

const meta = computed(() => META[route.params.kind] || META.glossary)
const items = computed(() => aggregate(meta.value.type))
const path = (note) => {
  const t = topicById(note.topicId)
  return t ? `${domainById(t.domainId).name} / ${t.name}` : '未归类'
}

// 聚合页是单行摘要，不渲染富文本，只把 ** 和 ` 这些标记抹掉，别让星号露出来
const plain = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '')

const done = (it) => {
  if (!confirm(`「${plain(it.block.text)}」已经补完了？这块会从笔记里删掉。`)) return
  dropBlock(it.note.id, it.block.id)
}
</script>

<template>
  <section class="page">
    <h1 class="page-title">{{ meta.title }}</h1>
    <p class="page-sub">{{ meta.hint }} 共 {{ items.length }} 条</p>

    <div v-if="!items.length" class="empty-state"><p>还没有内容。</p></div>

    <div v-if="meta.type === 'todo'" class="agg-list">
      <div v-for="(it, i) in items" :key="i" class="agg-item todo-item">
        <button class="todo-done" title="补完了，从笔记里去掉" @click="done(it)">✓</button>
        <div class="agg-main">
          <strong>{{ plain(it.block.text) || '（没写要补什么）' }}</strong>
        </div>
        <div class="agg-src">
          <RouterLink :to="`/n/${it.note.id}`">{{ it.note.title }}</RouterLink>
          · {{ path(it.note) }}
        </div>
      </div>
    </div>

    <div v-else class="agg-list">
      <RouterLink v-for="(it, i) in items" :key="i" :to="`/n/${it.note.id}`" class="agg-item">
        <div class="agg-main">
          <template v-if="meta.type === 'definition'">
            <strong>{{ plain(it.block.term) || '（未命名）' }}</strong>
            <span>{{ plain(it.block.text) }}</span>
          </template>
          <template v-else-if="meta.type === 'formula'">
            <code class="agg-formula">{{ it.block.latex }}</code>
            <span>{{ plain(it.block.text) }}</span>
          </template>
          <template v-else-if="meta.type === 'qa'">
            <strong>{{ plain(it.block.question) || '（未填问题）' }}</strong>
            <span>{{ plain(it.block.answer) }}</span>
          </template>
          <template v-else>
            <strong>{{ plain(it.block.text) }}</strong>
            <span>{{ plain(it.block.avoid) }}</span>
          </template>
        </div>
        <div class="agg-src">{{ it.note.title }} · {{ path(it.note) }}</div>
      </RouterLink>
    </div>
  </section>
</template>
