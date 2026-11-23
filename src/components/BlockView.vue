<script setup>
import { computed, ref, watch } from 'vue'
import katex from 'katex'
import { state } from '../lib/store.js'
import { isWholeCard, resolveTitle } from '../lib/links.js'

const props = defineProps({
  block: { type: Object, required: true },
  expand: { type: Boolean, default: false },
})
const emit = defineEmits(['open-note', 'make-note'])

const failed = ref(false)
watch(
  () => props.block.src,
  () => {
    failed.value = false
  },
)

const html = computed(() => {
  if (props.block.type !== 'formula') return ''
  try {
    return katex.renderToString(props.block.latex || '', {
      displayMode: true,
      throwOnError: false,
    })
  } catch {
    return ''
  }
})

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// [[另一篇的标题]] → 可点的 chip；标题对不上库里任何一篇时标成「未创建」
const chipHtml = (title, card) => {
  const hit = resolveTitle(title, state.notes)
  const cls = ['note-link', card ? 'note-link-card' : '', hit ? '' : 'missing'].filter(Boolean).join(' ')
  const attr = hit ? `data-note="${esc(hit.id)}"` : `data-make="${esc(title)}"`
  const tip = hit ? `跳到《${hit.title}》` : `还没有《${title}》，点一下新建`
  return `<button class="${cls}" ${attr} title="${esc(tip)}">${esc(hit ? hit.title : title)}</button>`
}

// 一段文字 → HTML：先转义，再处理 [[ ]] 和 [n]，顺序不能反（[[3]] 会被 [n] 规则先吃掉）
const htmlOf = (text) => {
  const raw = String(text || '')
  if (!raw) return ''
  const card = isWholeCard(raw)
  let s = esc(raw).replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (_m, t) => chipHtml(t.trim(), card))
  const refs = props.block.refs
  if (refs && refs.length) {
    s = s.replace(/\[(\d+)\]/g, (m, d) => {
      const r = refs[Number(d) - 1]
      return r ? `<button class="qa-cite" data-note="${esc(r.id)}" title="${esc(r.title)}">${d}</button>` : m
    })
  }
  return s
}

const paraHtml = computed(() => (props.block.type === 'paragraph' ? htmlOf(props.block.text) : ''))
const qaHtml = computed(() => (props.block.type === 'qa' ? htmlOf(props.block.answer) : ''))
const calloutHtml = computed(() => (props.block.type === 'callout' ? htmlOf(props.block.text) : ''))
const todoHtml = computed(() => (props.block.type === 'todo' ? htmlOf(props.block.text) : ''))
const defHtml = computed(() => (props.block.type === 'definition' ? htmlOf(props.block.text) : ''))
const defDetailHtml = computed(() => (props.block.type === 'definition' ? htmlOf(props.block.detail) : ''))

const onLinkClick = (e) => {
  const el = e.target.closest?.('.qa-cite, .note-link')
  if (!el) return
  if (el.dataset.note) emit('open-note', el.dataset.note)
  else if (el.dataset.make) emit('make-note', el.dataset.make)
}
</script>

<template>
  <h2 v-if="block.type === 'heading' && block.level === 2" class="blk-h2">{{ block.text }}</h2>
  <h3 v-else-if="block.type === 'heading'" class="blk-h3">{{ block.text }}</h3>

  <p v-else-if="block.type === 'paragraph'" class="blk-p" @click="onLinkClick" v-html="paraHtml"></p>

  <aside v-else-if="block.type === 'callout'" class="blk-callout" :class="'tone-' + (block.tone || 'tip')">
    <span class="callout-icon">{{ block.tone === 'warn' ? '!' : 'i' }}</span>
    <span @click="onLinkClick" v-html="calloutHtml"></span>
  </aside>

  <figure v-else-if="block.type === 'formula'" class="blk-formula">
    <div class="formula-body" v-html="html"></div>
    <figcaption v-if="block.text">{{ block.text }}</figcaption>
  </figure>

  <figure v-else-if="block.type === 'image'" class="blk-img">
    <img
      v-if="block.src && !failed"
      :src="block.src"
      :alt="block.text || '图片'"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="failed = true"
    />
    <div v-else class="img-bad">
      <span>{{ block.src ? '图没加载出来，链接可能失效或不许外链' : '还没填图片链接' }}</span>
      <a v-if="block.src" :href="block.src" target="_blank" rel="noreferrer">打开原图</a>
    </div>
    <figcaption v-if="block.text">{{ block.text }}</figcaption>
  </figure>

  <div v-else-if="block.type === 'definition'" class="blk-def">
    <div class="def-term">{{ block.term || '术语' }}</div>
    <div class="def-text" @click="onLinkClick" v-html="defHtml"></div>
    <div v-if="block.detail" class="def-detail" @click="onLinkClick" v-html="defDetailHtml"></div>
  </div>

  <div v-else-if="block.type === 'steps'" class="blk-steps">
    <div v-if="block.text" class="steps-title">{{ block.text }}</div>
    <ol>
      <li v-for="(s, i) in block.items || []" :key="i">{{ s }}</li>
    </ol>
  </div>

  <div v-else-if="block.type === 'comparison'" class="blk-cmp">
    <div class="cmp-head">
      <span></span>
      <span class="cmp-a">{{ block.left }}</span>
      <span class="cmp-b">{{ block.right }}</span>
    </div>
    <div v-for="(r, i) in block.rows || []" :key="i" class="cmp-row">
      <span class="cmp-k">{{ r.k }}</span>
      <span>{{ r.a }}</span>
      <span>{{ r.b }}</span>
    </div>
  </div>

  <details v-else-if="block.type === 'qa'" class="blk-qa" :open="expand">
    <summary><span class="qa-badge">Q</span>{{ block.question || '（未填问题）' }}</summary>
    <div class="qa-a" @click="onLinkClick" v-html="qaHtml"></div>
  </details>

  <div v-else-if="block.type === 'pitfall'" class="blk-pitfall">
    <div class="pit-title">坑</div>
    <div class="pit-row"><span class="pit-k">现象</span><span>{{ block.text }}</span></div>
    <div v-if="block.cause" class="pit-row"><span class="pit-k">原因</span><span>{{ block.cause }}</span></div>
    <div v-if="block.avoid" class="pit-row"><span class="pit-k">避免</span><span>{{ block.avoid }}</span></div>
  </div>

  <div v-else-if="block.type === 'todo'" class="blk-todo">
    <span class="todo-mark">待补</span><span @click="onLinkClick" v-html="todoHtml"></span>
  </div>

  <pre v-else-if="block.type === 'code'" class="blk-code"><code>{{ block.text }}</code></pre>

  <ul v-else-if="block.type === 'bulletList'" class="blk-list">
    <li v-for="(it, i) in block.items || []" :key="i">{{ it }}</li>
  </ul>

  <hr v-else-if="block.type === 'divider'" />

  <p v-else class="blk-p blk-unknown">[{{ block.type }}] {{ block.text }}</p>
</template>
