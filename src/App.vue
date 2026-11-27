<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  state,
  domainStats,
  flattenTopics,
  topicStats,
  createDomain,
  createTopic,
  renameDomain,
  renameTopic,
  removeTopic,
  removeDomain,
  orphanNotes,
  trashedNotes,
  snapshot,
  applyRemote,
} from './lib/store.js'
import { loadRemote, isConfigured } from './lib/remote.js'
import { pullAll, pushDirty, needsRestamp } from './lib/sync.js'
import SyncDialog from './components/SyncDialog.vue'
import AiPanel from './components/AiPanel.vue'

const route = useRoute()
const router = useRouter()
const navOpen = ref(false)
const q = ref('')
const editMode = ref(false)
const syncOpen = ref(false)
const aiOpen = ref(false)
const syncTip = ref('')
const open = reactive({ d4: true })
const treeOpen = reactive({ 't-variance': true })

// 域被删掉后剩下来的笔记，只在真有的时候露出来
const orphanCount = computed(() => orphanNotes().length)
const trashCount = computed(() => trashedNotes().length)

let timer = null
let quietUntil = 0

// 启动时：把云端按域拆开的文件合并回来，只重下载变了的部分
const pullQuiet = async () => {
  const cfg = loadRemote()
  if (!isConfigured(cfg)) return
  try {
    const r = await pullAll(cfg, snapshot())
    if (r) {
      quietUntil = Date.now() + 800
      if (r.changed && r.snapshot) applyRemote(r.snapshot)
      syncTip.value = r.legacy ? '云端还是老的单文件格式，下次保存会按域拆开' : '已拉取云端'
    }
    // 老格式的云端文件里带 updatedAt：趁这次开机把时间戳清掉，只做一次
    if (needsRestamp()) {
      quietUntil = Date.now() + 800
      const p = await pushDirty(cfg, snapshot())
      if (p.pushed.length) syncTip.value = `已清掉云端时间戳（${p.pushed.length} 个文件）`
    }
  } catch (e) {
    syncTip.value = '拉取失败，检查同步配置'
  }
}

onMounted(pullQuiet)

// 每次改动防抖上传，只写内容真的变了的域文件
watch(
  state,
  () => {
    if (Date.now() < quietUntil) return
    const cfg = loadRemote()
    if (!isConfigured(cfg)) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        const r = await pushDirty(cfg, snapshot())
        if (!r.pushed.length) return
        syncTip.value = '已上传 ' + r.pushed.map((p) => p.split('/').pop()).join('、')
      } catch (e) {
        syncTip.value = '上传失败：' + (e.message || e)
      }
    }, 2000)
  },
  { deep: true },
)

watch(
  () => route.fullPath,
  () => (navOpen.value = false),
)

const submitSearch = () => {
  if (q.value.trim()) router.push({ path: '/search', query: { q: q.value } })
}

const addTopic = (domainId, parentId) => {
  createTopic(domainId, parentId, parentId ? '新细分' : '新分类')
  open[domainId] = true
  if (parentId) treeOpen[parentId] = true
}

const delTopic = (t) => {
  const s = topicStats(t.id)
  const where = t.parentId ? '父级分类' : '「未归类」'
  const msg = s.all
    ? `删除「${t.name}」？${s.kids ? '其下级一并删除，' : ''}${s.all} 篇笔记会移到${where}。`
    : `删除「${t.name}」${s.kids ? '及其下级分类' : ''}？`
  if (confirm(msg)) removeTopic(t.id)
}

const delDomain = (d) => {
  const s = domainStats(d.id)
  const msg = s.notes
    ? `删除知识域「${d.name}」及其 ${s.topics} 个分类？\n\n${s.notes} 篇笔记不会消失，会落到「失去归属的笔记」，可以在那里重新指一个分类。`
    : `删除知识域「${d.name}」及其全部 ${s.topics} 个分类？`
  if (confirm(msg)) removeDomain(d.id, true)
}
</script>

<template>
  <header class="top">
    <button class="burger" @click="navOpen = !navOpen">☰</button>
    <RouterLink to="/" class="brand">知识库</RouterLink>
    <input v-model="q" class="search" placeholder="搜索全部笔记  Ctrl+K" @keyup.enter="submitSearch" />
    <nav class="quick">
      <RouterLink to="/agg/glossary">术语</RouterLink>
      <RouterLink to="/agg/formulas">公式</RouterLink>
      <RouterLink to="/agg/qa">问答</RouterLink>
      <RouterLink to="/agg/pitfalls">坑</RouterLink>
      <RouterLink to="/agg/todos">待补</RouterLink>
    </nav>
    <button class="sync-btn" title="AI 整理" @click="aiOpen = true">✨</button>
    <button class="sync-btn" :title="syncTip || '云同步设置'" @click="syncOpen = true">
      ☁<span v-if="syncTip" class="sync-dot"></span>
    </button>
  </header>

  <SyncDialog :open="syncOpen" @close="syncOpen = false" @synced="pullQuiet" />
  <AiPanel :open="aiOpen" @close="aiOpen = false" />

  <div class="shell">
    <aside class="side" :class="{ open: navOpen, editing: editMode }">
      <div class="side-head">
        <span>目录</span>
        <button class="side-edit" :class="{ on: editMode }" @click="editMode = !editMode">
          {{ editMode ? '完成' : '✎ 编辑' }}
        </button>
      </div>

      <div v-for="d in state.domains" :key="d.id" class="side-domain">
        <div class="side-row" :class="{ active: route.params.domainId === d.id }">
          <button v-if="!editMode" class="caret" @click="open[d.id] = !open[d.id]">
            {{ open[d.id] ? '▾' : '▸' }}
          </button>
          <span v-else class="caret ghost">·</span>

          <input
            v-if="editMode"
            class="side-inp dom"
            :value="d.name"
            @change="renameDomain(d.id, $event.target.value)"
          />
          <RouterLink v-else :to="`/d/${d.id}`" class="side-name">{{ d.name }}</RouterLink>

          <span class="side-count">{{ domainStats(d.id).notes }}</span>
          <button v-if="editMode" class="side-x" title="删除域" @click="delDomain(d)">×</button>
        </div>

        <div v-show="open[d.id] || editMode" class="side-topics">
          <template v-for="row in flattenTopics(d.id, editMode ? true : treeOpen)" :key="row.topic.id">
            <div
              class="side-row topic"
              :class="{
                active: route.params.topicId === row.topic.id,
                'depth-1': row.depth === 1,
                'depth-2': row.depth >= 2,
              }"
              :style="{ paddingLeft: 6 + row.depth * 14 + 'px' }"
            >
              <button
                v-if="!editMode && row.hasKids"
                class="caret"
                @click="treeOpen[row.topic.id] = !treeOpen[row.topic.id]"
              >
                {{ row.open ? '▾' : '▸' }}
              </button>
              <span v-else class="caret ghost">·</span>

              <input
                v-if="editMode"
                class="side-inp"
                :value="row.topic.name"
                @change="renameTopic(row.topic.id, $event.target.value)"
              />
              <RouterLink v-else :to="`/t/${row.topic.id}`" class="side-name">
                {{ row.topic.name }}
              </RouterLink>

              <span class="side-count" :class="{ zero: !topicStats(row.topic.id).all }">
                {{ topicStats(row.topic.id).all || '' }}
              </span>
              <template v-if="editMode">
                <button class="side-x" title="加下一级" @click="addTopic(d.id, row.topic.id)">＋</button>
                <button class="side-x" title="删除" @click="delTopic(row.topic)">×</button>
              </template>
            </div>
          </template>

          <button v-if="editMode" class="side-add" @click="addTopic(d.id, '')">
            ＋ {{ domainStats(d.id).topics ? '加一级分类' : '加分类' }}
          </button>
        </div>
      </div>

      <button v-if="editMode" class="side-add dom" @click="createDomain('新域')">＋ 新增知识域</button>

      <RouterLink v-if="orphanCount" to="/orphans" class="side-orphan">
        <span class="side-orphan-mark">!</span>
        失去归属的笔记
        <span class="side-orphan-n">{{ orphanCount }}</span>
      </RouterLink>

      <RouterLink v-if="trashCount" to="/trash" class="side-orphan quiet">
        <span class="side-orphan-mark">🗑</span>
        回收站
        <span class="side-orphan-n">{{ trashCount }}</span>
      </RouterLink>

      <p class="side-note">
        原型阶段数据存在浏览器 localStorage（键名 <code>myknowledge.v3</code>），刷新不丢。
      </p>
    </aside>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
