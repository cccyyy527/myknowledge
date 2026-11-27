<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  trashedNotes,
  restoreNote,
  purgeNote,
  emptyTrash,
  noteSummary,
  topicById,
  topicPath,
} from '../lib/store.js'

const router = useRouter()
const notes = computed(() => trashedNotes())

// 原来的分类还在不在：不在了就恢复成「失去归属」，别让它恢复完又是个黑洞
const alive = (n) => Boolean(topicById(n.topicId))
const where = (n) => {
  const t = topicById(n.topicId)
  if (t) return topicPath(t.id).map((x) => x.name).join(' / ')
  return n.topicId ? '原分类已删除' : '没有分类'
}

const when = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const restore = (n) => {
  restoreNote(n.id)
  if (alive(n)) router.push(`/n/${n.id}`)
}

const purge = (n) => {
  if (!confirm(`彻底删除「${n.title}」？这一步真的没法恢复了。`)) return
  purgeNote(n.id)
}

const clearAll = () => {
  if (!confirm(`清空回收站，${notes.value.length} 篇笔记将彻底删除。继续？`)) return
  emptyTrash()
}
</script>

<template>
  <section class="page">
    <div class="title-row">
      <h1 class="page-title">回收站</h1>
      <button v-if="notes.length" class="btn-ghost danger" @click="clearAll">清空回收站</button>
    </div>
    <p class="page-sub">
      删掉的笔记先放这里，不会立刻消失。恢复后回到原来的分类；原分类没了的会落到「失去归属的笔记」。
      共 {{ notes.length }} 篇。
    </p>

    <div v-if="!notes.length" class="empty-state"><p>回收站是空的。</p></div>

    <div v-for="n in notes" :key="n.id" class="orphan-row">
      <div class="orphan-main">
        <span class="orphan-title">{{ n.title }}</span>
        <p class="orphan-sum">{{ noteSummary(n) }}</p>
        <p class="orphan-where">
          原位置：{{ where(n) }}
          <span v-if="when(n.deletedAt)" class="muted"> · 删于 {{ when(n.deletedAt) }}</span>
        </p>
      </div>
      <div class="orphan-tools">
        <button class="btn-ghost" @click="restore(n)">恢复</button>
        <button class="btn-ghost danger" @click="purge(n)">彻底删除</button>
      </div>
    </div>
  </section>
</template>
