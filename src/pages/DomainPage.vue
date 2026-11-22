<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { domainById, topicsOf, topicStats, domainStats } from '../lib/store.js'

const route = useRoute()
const domain = computed(() => domainById(route.params.domainId))
</script>

<template>
  <section v-if="domain" class="page">
    <nav class="crumb"><RouterLink to="/">知识库</RouterLink> / {{ domain.name }}</nav>
    <h1 class="page-title">{{ domain.name }}</h1>
    <p class="page-sub">
      {{ domain.hint }} · 分类 {{ domainStats(domain.id).topics }}（叶子
      {{ domainStats(domain.id).leaves }}）· 已覆盖 {{ domainStats(domain.id).covered }} · 笔记
      {{ domainStats(domain.id).notes }}
    </p>

    <div class="grid topic-grid">
      <RouterLink
        v-for="t in topicsOf(domain.id)"
        :key="t.id"
        :to="`/t/${t.id}`"
        class="card topic-card"
        :class="{ empty: topicStats(t.id).all === 0 }"
      >
        <h4>
          {{ t.name }}
          <span v-if="topicStats(t.id).kids" class="kids">{{ topicStats(t.id).kids }} 子类</span>
        </h4>
        <div class="card-meta">
          <span v-if="topicStats(t.id).all">{{ topicStats(t.id).all }} 篇</span>
          <span v-else class="muted">+ 从这里开始</span>
          <span v-if="topicStats(t.id).todos" class="warn">待补 {{ topicStats(t.id).todos }}</span>
        </div>
      </RouterLink>
    </div>
  </section>
  <p v-else class="page">找不到这个域</p>
</template>
