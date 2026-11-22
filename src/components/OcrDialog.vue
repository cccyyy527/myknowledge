<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import katex from 'katex'
import { loadAI, isAiReady, ocrImage } from '../lib/ai.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 已有的图片链接；也可以直接塞一个 File / Blob（粘贴、拖进来）
  src: { type: [String, Object], default: '' },
  // 插到哪里去的说明（给用户看，真正落点在父组件里决定）
  where: { type: String, default: '' },
})
const emit = defineEmits(['close', 'insert'])

const filePick = ref(null)
const busy = ref(false)
const msg = ref('')
const bad = ref(false)
const result = ref(null)
const drag = ref(false)
const from = ref('')

const math = computed(() => {
  const latex = result.value?.latex
  if (!latex) return ''
  try {
    return katex.renderToString(latex, { displayMode: true, throwOnError: false })
  } catch {
    return ''
  }
})

const reset = () => {
  busy.value = false
  msg.value = ''
  bad.value = false
  result.value = null
  drag.value = false
  from.value = ''
}

const run = async (source, name = '') => {
  if (!source) return
  msg.value = ''
  bad.value = false
  result.value = null
  from.value = name
  if (!isAiReady(loadAI().vision)) {
    msg.value = '还没配视觉模型：顶栏 ✨ → 设置 → 视觉模型（智谱 glm-4v-flash 免费）'
    bad.value = true
    return
  }
  busy.value = true
  try {
    result.value = await ocrImage({ src: source, cfg: loadAI() })
  } catch (e) {
    const m = String(e.message || e)
    msg.value = /Failed to fetch|NetworkError|CORS|读不到/i.test(m)
      ? '这个链接不让别的网站读图，换成选本地截图或直接粘贴。'
      : m
    bad.value = true
  } finally {
    busy.value = false
  }
}

const pick = () => filePick.value && filePick.value.click()

const onFile = (e) => {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (f) run(f, f.name)
}

const onDrop = (e) => {
  drag.value = false
  const f = [...(e.dataTransfer?.files || [])].find((x) => String(x.type).startsWith('image/'))
  if (f) run(f, f.name)
  else {
    msg.value = '拖进来的不是图片'
    bad.value = true
  }
}

const pasteFile = (e) =>
  [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file' && String(it.type).startsWith('image/'))
    .map((it) => it.getAsFile())
    .find(Boolean)

const onPaste = (e) => {
  if (!props.open) return
  const f = pasteFile(e)
  if (!f) return
  e.preventDefault()
  run(f, '剪贴板截图')
}

const fromClipboard = async () => {
  try {
    const items = await navigator.clipboard.read()
    for (const it of items || []) {
      const type = (it.types || []).find((t) => String(t).startsWith('image/'))
      if (type) return run(await it.getType(type), '剪贴板截图')
    }
    msg.value = '剪贴板里没有图片，先截图（Win+Shift+S）再点一次'
    bad.value = true
  } catch {
    msg.value = '浏览器不让读剪贴板，直接在这一页按 Ctrl+V，或者选文件'
    bad.value = true
  }
}

const close = () => {
  reset()
  emit('close')
}

const doInsert = (type) => {
  const r = result.value
  if (!r) return
  emit(
    'insert',
    type === 'formula'
      ? { type: 'formula', latex: r.latex, text: r.text }
      : { type: 'paragraph', text: r.text },
  )
  close()
}

watch(
  () => props.open,
  (v) => {
    if (!v) {
      window.removeEventListener('paste', onPaste)
      return reset()
    }
    reset()
    window.addEventListener('paste', onPaste)
    if (props.src) run(props.src)
  },
  { immediate: true },
)

onBeforeUnmount(() => window.removeEventListener('paste', onPaste))
</script>

<template>
  <div v-if="open" class="ai-mask" @click.self="close">
    <div class="ai-box">
      <div class="ai-head">
        <strong>识图 · 截图转成可编辑内容</strong>
        <button class="ai-x" @click="close">×</button>
      </div>

      <div
        class="ocr-drop"
        :class="{ over: drag, busy }"
        @dragover.prevent="drag = true"
        @dragleave.prevent="drag = false"
        @drop.prevent="onDrop"
        @click="pick"
      >
        <span class="ocr-drop-main">{{ busy ? '识别中…' : '把截图拖到这里，或点一下选文件' }}</span>
        <span class="ocr-drop-sub">
          <template v-if="busy">图会缩到长边 1600px 再发出去</template>
          <template v-else>
            也可以直接 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴 · 图不会被存进笔记，只是读一遍
          </template>
        </span>
      </div>

      <div class="ai-acts wrap">
        <button class="chip-btn" :disabled="busy" @click="pick">选图片文件</button>
        <button class="chip-btn" :disabled="busy" @click="fromClipboard">读剪贴板</button>
        <input ref="filePick" type="file" accept="image/*" hidden @change="onFile" />
        <span v-if="from" class="ed-ocr-note">{{ from }}</span>
      </div>

      <p v-if="where" class="ai-hint">插到：{{ where }}</p>

      <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

      <div v-if="result" class="ed-ocr">
        <template v-if="result.kind === 'formula'">
          <p class="ed-hint">识别成公式了，核对一下 LaTeX（可以直接改）：</p>
          <textarea v-model="result.latex" class="inp inp-mono inp-text" rows="3" />
          <div v-if="math" class="ed-preview" v-html="math"></div>
          <input v-model="result.text" class="inp" placeholder="一句话说这是什么（可选）" />
          <div class="ed-ocr-acts">
            <button class="chip-btn" @click="doInsert('formula')">+ 插入公式块</button>
            <button class="chip-btn" @click="doInsert('paragraph')">+ 当段落插入</button>
            <button class="chip-btn" @click="reset">换一张</button>
          </div>
        </template>
        <template v-else>
          <p class="ed-hint">识别成文字了，核对一下：</p>
          <textarea v-model="result.text" class="inp inp-text" rows="5" />
          <div class="ed-ocr-acts">
            <button class="chip-btn" @click="doInsert('paragraph')">+ 插入段落</button>
            <button class="chip-btn" @click="reset">换一张</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
