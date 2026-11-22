<script setup>
import { state, domainStats, notesOfDomain } from '../lib/store.js'
</script>

<template>
  <section class="page">
    <h1 class="page-title">知识库</h1>
    <p class="page-sub">
      9 个域 · {{ state.topics.length }} 个子分类 · {{ state.notes.length }} 篇笔记
      —— 覆盖度是算出来的，不用自评。
    </p>

    <div class="grid domain-grid">
      <RouterLink v-for="d in state.domains" :key="d.id" :to="`/d/${d.id}`" class="card domain-card">
        <h3>{{ d.name }}</h3>
        <p class="card-hint">{{ d.hint }}</p>
        <div class="bar"><i :style="{ width: (domainStats(d.id).covered / domainStats(d.id).topics) * 100 + '%' }"></i></div>
        <div class="card-meta">
          <span>覆盖 {{ domainStats(d.id).covered }}/{{ domainStats(d.id).topics }}</span>
          <span>笔记 {{ domainStats(d.id).notes }}</span>
          <span v-if="domainStats(d.id).todos" class="warn">待补 {{ domainStats(d.id).todos }}</span>
        </div>
      </RouterLink>
    </div>
  </section>
</template>
