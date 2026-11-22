<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { state, domainStats, topicsOf, notesOfTopic } from './lib/store.js'

const route = useRoute()
const router = useRouter()
const navOpen = ref(false)
const q = ref('')
const open = ref({ d4: true })

watch(() => route.fullPath, () => (navOpen.value = false))

const submitSearch = () => {
  if (q.value.trim()) router.push({ path: '/search', query: { q: q.value } })
}

const activeDomain = computed(() => route.params.domainId || null)
const activeTopic = computed(() => route.params.topicId || null)
</script>

<template>
  <header class="top">
    <button class="burger" @click="navOpen = !navOpen">☰</button>
    <RouterLink to="/" class="brand">知识库</RouterLink>
    <input
      v-model="q"
      class="search"
      placeholder="搜索全部笔记  Ctrl+K"
      @keyup.enter="submitSearch"
    />
    <nav class="quick">
      <RouterLink to="/agg/glossary">术语</RouterLink>
      <RouterLink to="/agg/formulas">公式</RouterLink>
      <RouterLink to="/agg/qa">问答</RouterLink>
      <RouterLink to="/agg/pitfalls">坑</RouterLink>
    </nav>
  </header>

  <div class="shell">
    <aside class="side" :class="{ open: navOpen }">
      <div v-for="d in state.domains" :key="d.id" class="side-domain">
        <div class="side-row" :class="{ active: activeDomain === d.id }">
          <button class="caret" @click="open[d.id] = !open[d.id]">
            {{ open[d.id] ? '▾' : '▸' }}
          </button>
          <RouterLink :to="`/d/${d.id}`" class="side-name">{{ d.name }}</RouterLink>
          <span class="side-count">{{ domainStats(d.id).notes }}</span>
        </div>
        <div v-show="open[d.id]" class="side-topics">
          <RouterLink
            v-for="t in topicsOf(d.id)"
            :key="t.id"
            :to="`/t/${t.id}`"
            class="side-topic"
            :class="{ active: activeTopic === t.id, empty: notesOfTopic(t.id).length === 0 }"
          >
            <span>{{ t.name }}</span>
            <span class="side-count">{{ notesOfTopic(t.id).length || '' }}</span>
          </RouterLink>
        </div>
      </div>
      <p class="side-note">
        原型阶段数据存在浏览器 localStorage（键名 <code>myknowledge.v1</code>），刷新不丢。
      </p>
    </aside>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
