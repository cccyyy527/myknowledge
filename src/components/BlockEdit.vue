<script setup>
import { computed } from 'vue'
import katex from 'katex'

const props = defineProps({
  block: { type: Object, required: true },
  index: { type: Number, default: 0 },
  deletable: { type: Boolean, default: true },
})
const emit = defineEmits(['remove', 'move', 'ai'])

const preview = computed(() => {
  if (props.block.type !== 'formula' || !props.block.latex) return ''
  try {
    return katex.renderToString(props.block.latex, { displayMode: true, throwOnError: false })
  } catch {
    return ''
  }
})

const LABELS = {
  paragraph: '段落',
  heading: '小节标题',
  callout: '提示',
  formula: '公式',
  definition: '概念',
  steps: '步骤',
  comparison: '对比',
  qa: '问答',
  pitfall: '坑',
  todo: '待补',
  code: '代码',
  bulletList: '列表',
}
</script>

<template>
  <div class="ed-row" :class="'ed-' + block.type">
    <div class="ed-label">
      <span>{{ LABELS[block.type] || block.type }}</span>
      <span class="ed-actions">
        <button v-if="block.type !== 'heading'" class="ed-ai" title="用 AI 改写这一块" @click="emit('ai')">
          ✨
        </button>
        <button title="上移" @click="emit('move', -1)">↑</button>
        <button title="下移" @click="emit('move', 1)">↓</button>
        <button v-if="deletable" title="删除" @click="emit('remove')">×</button>
      </span>
    </div>

    <template v-if="block.type === 'heading'">
      <input v-model="block.text" class="inp inp-heading" placeholder="小节标题" />
    </template>

    <template v-else-if="block.type === 'paragraph'">
      <textarea v-model="block.text" class="inp inp-text" rows="2" placeholder="写点内容…" />
    </template>

    <template v-else-if="block.type === 'callout'">
      <select v-model="block.tone" class="inp inp-mini">
        <option value="tip">提示</option>
        <option value="warn">注意</option>
      </select>
      <textarea v-model="block.text" class="inp inp-text" rows="2" placeholder="提示内容" />
    </template>

    <template v-else-if="block.type === 'formula'">
      <input v-model="block.latex" class="inp inp-mono" placeholder="LaTeX，例如 \operatorname{Var}(Y)" />
      <div v-if="preview" class="ed-preview" v-html="preview"></div>
      <textarea v-model="block.text" class="inp inp-text" rows="2" placeholder="变量说明 / 解读" />
    </template>

    <template v-else-if="block.type === 'definition'">
      <input v-model="block.term" class="inp" placeholder="术语" />
      <textarea v-model="block.text" class="inp inp-text" rows="2" placeholder="一句话定义" />
      <textarea v-model="block.detail" class="inp inp-text" rows="2" placeholder="展开细节（可选）" />
    </template>

    <template v-else-if="block.type === 'steps'">
      <input v-model="block.text" class="inp" placeholder="步骤标题（可选）" />
      <input
        v-for="(_, i) in block.items || []"
        :key="i"
        v-model="block.items[i]"
        class="inp"
        :placeholder="`第 ${i + 1} 步`"
      />
      <button class="btn-ghost" @click="block.items.push('')">+ 加一步</button>
    </template>

    <template v-else-if="block.type === 'comparison'">
      <div class="two">
        <input v-model="block.left" class="inp" placeholder="左侧名称" />
        <input v-model="block.right" class="inp" placeholder="右侧名称" />
      </div>
      <div v-for="(r, i) in block.rows || []" :key="i" class="two">
        <input v-model="r.k" class="inp inp-mini" placeholder="维度" />
        <input v-model="r.a" class="inp" placeholder="左侧" />
        <input v-model="r.b" class="inp" placeholder="右侧" />
      </div>
      <button class="btn-ghost" @click="block.rows.push({ k: '', a: '', b: '' })">+ 加一行</button>
    </template>

    <template v-else-if="block.type === 'qa'">
      <input v-model="block.question" class="inp" placeholder="问题" />
      <textarea v-model="block.answer" class="inp inp-text" rows="3" placeholder="答案" />
    </template>

    <template v-else-if="block.type === 'pitfall'">
      <textarea v-model="block.text" class="inp inp-text" rows="2" placeholder="现象：哪里砸了" />
      <textarea v-model="block.cause" class="inp inp-text" rows="2" placeholder="原因" />
      <textarea v-model="block.avoid" class="inp inp-text" rows="2" placeholder="怎么避免" />
    </template>

    <template v-else-if="block.type === 'todo'">
      <input v-model="block.text" class="inp" placeholder="待补什么" />
    </template>

    <template v-else-if="block.type === 'code'">
      <textarea v-model="block.text" class="inp inp-mono inp-text" rows="3" placeholder="代码" />
    </template>

    <template v-else-if="block.type === 'bulletList'">
      <input
        v-for="(_, i) in block.items || []"
        :key="i"
        v-model="block.items[i]"
        class="inp"
        placeholder="列表项"
      />
      <button class="btn-ghost" @click="block.items.push('')">+ 加一项</button>
    </template>

    <template v-else>
      <textarea v-model="block.text" class="inp inp-text" rows="2" />
    </template>
  </div>
</template>
