<script setup>
import { computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import {
  state,
  orphanNotes,
  adoptNote,
  removeNote,
  noteSummary,
  flattenTopics,
  topicById,
  topicPath,
} from '../lib/store.js'

const router = useRouter()

const notes = computed(() => orphanNotes())

// 每篇笔记各自记住「要挪到哪个分类」，默认第一个
const groups = computed(() =>
  state.domains
    .map((d) => ({ domain: d, rows: flattenTopics(d.id, true) }))
    .filter((g) => g.rows.length),
)
const firstTopic = () => groups.value[0]?.rows[0]?.topic?.id || ''
const pick = reactive({})

const topicOf = (id) => (pick[id] === undefined ? firstTopic() : pick[id])

const where = (note) => {
  const t = topicById(note.topicId)
  if (t) return topicPath(t.id).map((x) => x.name).join(' / ')
  return note.topicId ? `已删除的分类（${note.topicId}）` : '没有分类'
}

const move = (note) => {
  if (adoptNote(note.id, topicOf(note.id))) router.push(`/n/${note.id}`)
}

const drop = (note) => {
  if (!confirm(`删除「${note.title}」？原型阶段无法恢复。`)) return
  removeNote(note.id)
}
</script>

<template>
  <section class="page">
    <h1 class="page-title">失去归属的笔记</h1>
    <p class="page-sub">
      这些笔记原来所在的域已经被删掉了（或从别的设备合并回来时找不到域），文件层面暂时存在
      <code>notes/_orphan.json</code> 里。给它们重新指一个分类，就能回到目录。
    </p>

    <div v-if="!notes.length" class="empty-state">
      <p>没有这类笔记，目录是干净的。</p>
    </div>

    <div v-for="n in notes" :key="n.id" class="orphan-row">
      <div class="orphan-main">
        <RouterLink :to="`/n/${n.id}`" class="orphan-title">{{ n.title }}</RouterLink>
        <p class="orphan-sum">{{ noteSummary(n) }}</p>
        <p class="orphan-where">原位置：{{ where(n) }}</p>
      </div>

      <div class="orphan-tools">
        <select v-model="pick[n.id]" class="inp orphan-sel">
          <optgroup v-for="g in groups" :key="g.domain.id" :label="g.domain.name">
            <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
              {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
            </option>
          </optgroup>
        </select>
        <button class="btn-ghost" :disabled="!topicOf(n.id)" @click="move(n)">移到这里</button>
        <button class="btn-ghost danger" @click="drop(n)">删除</button>
      </div>
    </div>
  </section>
</template>
