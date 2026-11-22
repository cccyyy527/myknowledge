<script setup>
import { ref, computed, watch } from 'vue'
import { state, snapshot, applyRemote } from '../lib/store.js'
import { loadRemote, saveRemote, clearRemote, isConfigured } from '../lib/remote.js'
import { pullAll, pushDirty, resetMeta } from '../lib/sync.js'
import { notesDirOf } from '../lib/split.js'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close', 'synced'])

const cfg = ref(loadRemote())
const busy = ref('')
const msg = ref('')
const bad = ref(false)

watch(
  () => props.open,
  (v) => {
    if (v) {
      cfg.value = loadRemote()
      msg.value = ''
      bad.value = false
    }
  },
)

const say = (text, isBad = false) => {
  msg.value = text
  bad.value = isBad
}

const persist = () => {
  saveRemote(cfg.value)
  emit('synced')
  say('配置已保存到本机浏览器，之后每次编辑会自动上传')
}

const withBusy = async (label, fn) => {
  if (busy.value) return
  busy.value = label
  try {
    await fn()
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const doPull = () =>
  withBusy('pull', async () => {
    if (!isConfigured(cfg.value)) return say('先填 owner / repo / token', true)
    const r = await pullAll(cfg.value, snapshot(), { ignoreLocal: true })
    if (!r) return say('云端还没有 kb.json，点「上传」建立第一份')
    applyRemote(r.snapshot)
    emit('synced')
    const t = r.snapshot.updatedAt ? new Date(r.snapshot.updatedAt).toLocaleString() : '未知时间'
    say(r.legacy ? `已读入云端的老格式 kb.json（修改于 ${t}），下次上传会自动按域拆开` : `已用云端数据覆盖本地（云端修改于 ${t}）`)
  })

const doPush = () =>
  withBusy('push', async () => {
    if (!isConfigured(cfg.value)) return say('先填 owner / repo / token', true)
    const r = await pushDirty(cfg.value, snapshot(), { force: true })
    emit('synced')
    say(`已上传 ${r.pushed.length} 个文件：${r.pushed.join('、')}`)
  })

const doForget = () => {
  if (!confirm('断开后不再自动上传，本机已填的 token 会被清除。继续？')) return
  clearRemote()
  resetMeta()
  cfg.value = loadRemote()
  emit('synced')
  say('已断开云端同步，数据仍在本地')
}

const noteCount = () => state.notes.length
const notesDir = computed(() => `${notesDirOf(cfg.value) || 'notes'}/`)
</script>

<template>
  <div v-if="open" class="sync-mask" @click.self="emit('close')">
    <div class="sync-box">
      <div class="sync-head">
        <strong>云同步</strong>
        <button class="sync-x" @click="emit('close')">×</button>
      </div>

      <p class="sync-tip">
        数据存在你 GitHub 的私有仓库里，一台设备上传、另一台拉取即可同步。当前本机有
        <b>{{ noteCount() }}</b> 篇笔记。
      </p>

      <label class="sync-row">
        <span>用户名</span>
        <input v-model.trim="cfg.owner" placeholder="cccyyy527" />
      </label>
      <label class="sync-row">
        <span>仓库名</span>
        <input v-model.trim="cfg.repo" placeholder="myknowledge-data" />
      </label>
      <label class="sync-row">
        <span>分支</span>
        <input v-model.trim="cfg.branch" placeholder="main" />
      </label>
      <label class="sync-row">
        <span>索引文件</span>
        <input v-model.trim="cfg.path" placeholder="kb.json" />
      </label>
      <label class="sync-row">
        <span>Token</span>
        <input v-model.trim="cfg.token" type="password" placeholder="github_pat_..." />
      </label>

      <p class="sync-hint">
        索引文件只放分类树；笔记按域拆到 <b>{{ notesDir }}</b> 下（如 <b>d4.json</b>），
        改一篇笔记只写它所在域的那一个文件。
      </p>

      <p class="sync-hint">
        去 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
        tokens，只勾这一个仓库的 <b>Contents: Read and write</b>，其余全留空。Token
        只存在本机浏览器，不会上传到任何第三方。
      </p>

      <div class="sync-acts">
        <button @click="persist">保存配置</button>
        <button :disabled="!!busy" @click="doPull">{{ busy === 'pull' ? '拉取中…' : '↓ 用云端覆盖本地' }}</button>
        <button :disabled="!!busy" @click="doPush">{{ busy === 'push' ? '上传中…' : '↑ 用本地覆盖云端' }}</button>
        <button class="danger" @click="doForget">断开</button>
      </div>

      <p v-if="msg" class="sync-msg" :class="{ bad }">{{ msg }}</p>
    </div>
  </div>
</template>
