<script setup>
import { computed, ref } from 'vue'
import katex from 'katex'
import OcrDialog from './OcrDialog.vue'
import { liveNotes } from '../lib/store.js'
import { normTitle } from '../lib/links.js'

const props = defineProps({
  block: { type: Object, required: true },
  index: { type: Number, default: 0 },
  deletable: { type: Boolean, default: true },
})
const emit = defineEmits(['remove', 'move', 'ai', 'insert', 'insertBefore'])

const preview = computed(() => {
  if (props.block.type !== 'formula' || !props.block.latex) return ''
  try {
    return katex.renderToString(props.block.latex, { displayMode: true, throwOnError: false })
  } catch {
    return ''
  }
})

/* ---------- 多行输入框跟着内容长高，框里不要再上下滚 ---------- */
const grow = (el) => {
  if (!el || el.tagName !== 'TEXTAREA') return
  el.classList.add('grow-ta')
  el.style.height = 'auto'
  // box-sizing 是 border-box，scrollHeight 不含边框，得补回
  el.style.height = el.scrollHeight + (el.offsetHeight - el.clientHeight) + 'px'
}

const vGrow = { mounted: grow, updated: grow }

/* ---------- 打 [[ 时弹出笔记候选 ----------
   插进去的是 [[id]]，而不是标题：链接认 id，所以改名 / 换分类都不断。
   标题对不上任何一篇时（想新建），仍然写 [[标题]]，由渲染层标成「未创建」。 */
const wiki = ref(null)
const closeWiki = () => {
  wiki.value = null
}

const syncWiki = (el) => {
  const caret = el.selectionStart ?? 0
  const upto = String(el.value || '').slice(0, caret)
  const open = upto.lastIndexOf('[[')
  if (open < 0) return closeWiki()
  const seg = upto.slice(open + 2)
  if (/[\[\]\n]/.test(seg)) return closeWiki()
  // 光标落在 [[id|别名 里时，只拿别名部分去匹配
  const bar = seg.lastIndexOf('|')
  const q = normTitle(bar >= 0 ? seg.slice(bar + 1) : seg)
  const seen = new Set()
  const list = []
  for (const n of liveNotes()) {
    const t = String(n.title || '').trim()
    const k = normTitle(t)
    if (!k || seen.has(k) || (q && !k.includes(q))) continue
    seen.add(k)
    list.push(n)
  }
  const items = list.slice(0, 8).map((n) => ({ id: n.id, title: n.title, fresh: false }))
  const typed = (bar >= 0 ? seg.slice(bar + 1) : seg).trim()
  if (q && !list.some((n) => normTitle(n.title) === q)) items.unshift({ id: '', title: typed, fresh: true })
  if (!items.length) return closeWiki()
  const r = el.getBoundingClientRect()
  wiki.value = {
    items,
    sel: 0,
    el,
    start: open,
    caret,
    alias: bar >= 0 ? typed : '',
    x: r.left,
    y: r.bottom + 4,
    w: Math.max(180, Math.min(r.width || 240, 320)),
  }
}

const onWikiInput = (e) => {
  const tag = e.target?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') syncWiki(e.target)
}

const pickWiki = (it) => {
  const s = wiki.value
  if (!s || !it) return
  const el = s.el
  el.focus()
  el.setSelectionRange(s.start, s.caret)
  // 有 id 就写 id；顺手打了别名（[[xx|别名）就一起保住
  const text = it.id ? (s.alias ? `[[${it.id}|${s.alias}]]` : `[[${it.id}]]`) : `[[${it.title}]]`
  el.setRangeText(text, s.start, s.caret, 'end')
  el.dispatchEvent(new Event('input'))
  closeWiki()
}

const onWikiKey = (e) => {
  if (!wiki.value) return
  const n = wiki.value.items.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    wiki.value.sel = (wiki.value.sel + 1) % n
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    wiki.value.sel = (wiki.value.sel - 1 + n) % n
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    pickWiki(wiki.value.items[wiki.value.sel])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeWiki()
  }
}

// 点候选是 mousedown.prevent，走不到 blur；这里兜住键盘 Tab 出去的情况
const onWikiBlur = () => closeWiki()

/* ---------- 图片：识图交给 OcrDialog（本地截图 / 粘贴都行） ---------- */

const ocrOpen = ref(false)

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
  image: '图片',
}
</script>

<template>
  <div class="ed-row" :class="'ed-' + block.type" :data-bid="block.id">
    <div class="ed-label">
      <span>{{ LABELS[block.type] || block.type }}</span>
      <span class="ed-actions">
        <button title="在这块前 / 后插内容" @click="emit('insertBefore')">＋</button>
        <button v-if="block.type !== 'heading'" class="ed-ai" title="用 AI 改写这一块" @click="emit('ai')">
          ✨
        </button>
        <button title="上移" @click="emit('move', -1)">↑</button>
        <button title="下移" @click="emit('move', 1)">↓</button>
        <button
          v-if="deletable"
          :title="block.type === 'heading' ? '删掉这一节（含里面的块）' : '删除'"
          @click="emit('remove')"
        >
          ×
        </button>
      </span>
    </div>

    <template v-if="block.type === 'heading'">
      <input v-model="block.text" class="inp inp-heading" placeholder="小节标题" />
    </template>

    <template v-else-if="block.type === 'paragraph'">
      <textarea
        v-model="block.text"
        v-grow
        class="inp inp-text"
        rows="2"
        placeholder="写点内容…（打 [[ 可以引用另一篇笔记）"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
    </template>

    <template v-else-if="block.type === 'callout'">
      <select v-model="block.tone" class="inp inp-mini">
        <option value="tip">提示</option>
        <option value="warn">注意</option>
      </select>
      <textarea
        v-model="block.text"
        v-grow
        class="inp inp-text"
        rows="2"
        placeholder="提示内容"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
    </template>

    <template v-else-if="block.type === 'formula'">
      <input v-model="block.latex" class="inp inp-mono" placeholder="LaTeX，例如 \operatorname{Var}(Y)" />
      <div v-if="preview" class="ed-preview" v-html="preview"></div>
      <textarea v-model="block.text" v-grow class="inp inp-text" rows="2" placeholder="变量说明 / 解读" />
    </template>

    <template v-else-if="block.type === 'definition'">
      <input v-model="block.term" class="inp" placeholder="术语" />
      <textarea
        v-model="block.text"
        v-grow
        class="inp inp-text"
        rows="2"
        placeholder="一句话定义"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
      <textarea
        v-model="block.detail"
        v-grow
        class="inp inp-text"
        rows="2"
        placeholder="展开细节（可选）"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
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
      <textarea
        v-model="block.answer"
        v-grow
        class="inp inp-text"
        rows="3"
        placeholder="答案"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
    </template>

    <template v-else-if="block.type === 'pitfall'">
      <textarea v-model="block.text" v-grow class="inp inp-text" rows="2" placeholder="现象：哪里砸了" />
      <textarea v-model="block.cause" v-grow class="inp inp-text" rows="2" placeholder="原因" />
      <textarea v-model="block.avoid" v-grow class="inp inp-text" rows="2" placeholder="怎么避免" />
    </template>

    <template v-else-if="block.type === 'todo'">
      <input
        v-model="block.text"
        class="inp"
        placeholder="待补什么"
        @input="onWikiInput"
        @keydown="onWikiKey"
        @blur="onWikiBlur"
      />
    </template>

    <template v-else-if="block.type === 'image'">
      <input v-model.trim="block.src" class="inp inp-mono" placeholder="图片链接 https://…" />
      <input v-model="block.text" class="inp" placeholder="图注（可选，能参与搜索）" />
      <div v-if="block.src" class="ed-preview ed-img-preview">
        <img :src="block.src" alt="" loading="lazy" referrerpolicy="no-referrer" />
      </div>
      <p class="ed-hint">本地截图：点下面「识图」拖进来或直接 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴，识别完先核对再插。
        想把图本身留在笔记里当凭证，就把截图拖进 GitHub 任意 issue 输入框，会生成一串
        <code>user-attachments</code> 链接，粘到上面那行。</p>

      <div class="ed-ocr-acts">
        <button class="chip-btn" @click="ocrOpen = true">
          🔍 识图 · 把图里的式子抄成公式
        </button>
        <span class="ed-ocr-note">公式不用再手打</span>
      </div>

      <OcrDialog
        :open="ocrOpen"
        :src="block.src"
        :where="'这个图片块下面一格'"
        @close="ocrOpen = false"
        @insert="(patch) => emit('insert', patch)"
      />
    </template>

    <template v-else-if="block.type === 'code'">
      <textarea v-model="block.text" v-grow class="inp inp-mono inp-text" rows="3" placeholder="代码" />
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
      <textarea v-model="block.text" v-grow class="inp inp-text" rows="2" />
    </template>

    <Teleport to="body">
      <div
        v-if="wiki"
        class="wiki-pop"
        :style="{ left: wiki.x + 'px', top: wiki.y + 'px', width: wiki.w + 'px' }"
      >
        <button
          v-for="(it, i) in wiki.items"
          :key="it.title + i"
          class="wiki-opt"
          :class="{ on: i === wiki.sel, fresh: it.fresh }"
          @mousedown.prevent="pickWiki(it)"
          @mouseenter="wiki.sel = i"
        >
          <span class="wiki-opt-t">{{ it.title }}</span>
          <span v-if="it.fresh" class="wiki-opt-k">新建</span>
        </button>
        <div class="wiki-foot">↑↓ 选 · Enter 插进去 · Esc 关掉</div>
      </div>
    </Teleport>
  </div>
</template>
