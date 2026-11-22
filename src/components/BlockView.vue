<script setup>
import { computed } from 'vue'
import katex from 'katex'

const props = defineProps({ block: { type: Object, required: true } })

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
</script>

<template>
  <h2 v-if="block.type === 'heading' && block.level === 2" class="blk-h2">{{ block.text }}</h2>
  <h3 v-else-if="block.type === 'heading'" class="blk-h3">{{ block.text }}</h3>

  <p v-else-if="block.type === 'paragraph'" class="blk-p">{{ block.text }}</p>

  <aside v-else-if="block.type === 'callout'" class="blk-callout" :class="'tone-' + (block.tone || 'tip')">
    <span class="callout-icon">{{ block.tone === 'warn' ? '!' : 'i' }}</span>
    <span>{{ block.text }}</span>
  </aside>

  <figure v-else-if="block.type === 'formula'" class="blk-formula">
    <div class="formula-body" v-html="html"></div>
    <figcaption v-if="block.text">{{ block.text }}</figcaption>
  </figure>

  <div v-else-if="block.type === 'definition'" class="blk-def">
    <div class="def-term">{{ block.term || '术语' }}</div>
    <div class="def-text">{{ block.text }}</div>
    <div v-if="block.detail" class="def-detail">{{ block.detail }}</div>
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

  <details v-else-if="block.type === 'qa'" class="blk-qa">
    <summary><span class="qa-badge">Q</span>{{ block.question || '（未填问题）' }}</summary>
    <div class="qa-a">{{ block.answer }}</div>
  </details>

  <div v-else-if="block.type === 'pitfall'" class="blk-pitfall">
    <div class="pit-title">坑</div>
    <div class="pit-row"><span class="pit-k">现象</span><span>{{ block.text }}</span></div>
    <div v-if="block.cause" class="pit-row"><span class="pit-k">原因</span><span>{{ block.cause }}</span></div>
    <div v-if="block.avoid" class="pit-row"><span class="pit-k">避免</span><span>{{ block.avoid }}</span></div>
  </div>

  <div v-else-if="block.type === 'todo'" class="blk-todo">
    <span class="todo-mark">待补</span>{{ block.text }}
  </div>

  <pre v-else-if="block.type === 'code'" class="blk-code"><code>{{ block.text }}</code></pre>

  <ul v-else-if="block.type === 'bulletList'" class="blk-list">
    <li v-for="(it, i) in block.items || []" :key="i">{{ it }}</li>
  </ul>

  <hr v-else-if="block.type === 'divider'" />

  <p v-else class="blk-p blk-unknown">[{{ block.type }}] {{ block.text }}</p>
</template>
