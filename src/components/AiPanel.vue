<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { state, createNote, idifyBlocks, topicPath, flattenTopics } from '../lib/store.js'
import { loadAI, saveAI, clearAI, isAiReady, composeNote, assembleBlocks, ping, SKILLS, loadSkillOff, saveSkillOff, loadSkillPref, saveSkillPref } from '../lib/ai.js'
import BlockView from './BlockView.vue'
import AiAsk from './AiAsk.vue'
import AiCross from './AiCross.vue'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])
const router = useRouter()

const tab = ref('compose')
const cfg = ref(loadAI())
const raw = ref('')
const picked = ref('')
const busy = ref('')
const msg = ref('')
const bad = ref(false)
const result = ref(null)

const say = (text, isBad = false) => {
  msg.value = text
  bad.value = isBad
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    cfg.value = loadAI()
    msg.value = ''
    bad.value = false
    result.value = null
    tab.value = isAiReady(cfg.value) ? 'compose' : 'setup'
  },
)

// 分类下拉：按域分组，缩进表示层级，和侧边栏一致
const groups = computed(() =>
  state.domains.map((d) => ({
    domain: d,
    rows: flattenTopics(d.id, true),
  })),
)

const pathOf = (id) => (id ? topicPath(id).map((t) => t.name).join(' / ') : '')

const doCompose = async () => {
  if (!raw.value.trim()) return say('先把要整理的内容贴进来', true)
  if (!isAiReady(cfg.value)) {
    tab.value = 'setup'
    return say('先配好 API Key', true)
  }
  busy.value = 'compose'
  msg.value = ''
  result.value = null
  try {
    const r = await composeNote(raw.value, cfg.value)
    result.value = r
    picked.value = r.topicId
    if (!r.blocks.length) say('模型没切出有效内容，换个写法再试', true)
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const writeNote = () => {
  if (!result.value || !picked.value) return
  const note = createNote(picked.value)
  note.title = result.value.title
  note.blocks = idifyBlocks(assembleBlocks(result.value.blocks))
  emit('close')
  router.push(`/n/${note.id}`)
}

const save = () => {
  const c = { ...cfg.value }
  c.base = c.base.trim()
  c.model = c.model.trim()
  c.key = c.key.trim()
  const v = { ...(c.vision || {}) }
  v.base = String(v.base || '').trim()
  v.model = String(v.model || '').trim()
  v.key = String(v.key || '').trim()
  c.vision = v
  cfg.value = c
  saveAI(c)
  say(isAiReady(c) ? '已保存' : '已保存，但还缺 API Key', !isAiReady(c))
}

const doPing = async (which = 'text') => {
  busy.value = which === 'vision' ? 'pvision' : 'ping'
  say('')
  try {
    const target = which === 'vision' ? cfg.value.vision : cfg.value
    const r = await ping(target)
    say(`${which === 'vision' ? '视觉模型' : '连通'}正常，回了：${r.slice(0, 20)}`)
  } catch (e) {
    say(String(e.message || e), true)
  } finally {
    busy.value = ''
  }
}

const forget = () => {
  if (!confirm('清除本机保存的 API Key？')) return
  clearAI()
  cfg.value = loadAI()
  say('已清除')
}

// 技能开关只改「问库里」那套预设的显示与启用，不影响检索；默认那档永远开着
const off = ref(loadSkillOff())
const isOn = (id) => !id || !off.value.includes(id)
const toggleSkill = (id) => {
  if (!id) return
  off.value = isOn(id) ? [...off.value, id] : off.value.filter((x) => x !== id)
  saveSkillOff(off.value)
  if (!isOn(loadSkillPref().id)) saveSkillPref({ id: '' })
}

const extra = ref(loadSkillPref().extra)
const saveExtra = () => {
  saveSkillPref({ extra: extra.value })
  say('自定义指令已保存')
}
</script>

<template>
  <div v-if="open" class="ai-mask" @click.self="emit('close')">
    <div class="ai-box">
      <div class="ai-head">
        <strong>AI 助手</strong>
        <button class="ai-x" @click="emit('close')">×</button>
      </div>

      <div class="ai-tabs">
        <button :class="{ on: tab === 'compose' }" @click="tab = 'compose'">收进来</button>
        <button :class="{ on: tab === 'ask' }" @click="tab = 'ask'">问库里</button>
        <button :class="{ on: tab === 'cross' }" @click="tab = 'cross'">跨笔记</button>
        <button :class="{ on: tab === 'setup' }" @click="tab = 'setup'">设置</button>
      </div>

      <!-- 收进来 -->
      <template v-if="tab === 'compose'">
        <p class="ai-tip">
          贴一段零散笔记，AI 会挑分类、切成知识块、按「核心结论 / 推导 / 高频问法 / 踩过的坑」归位。写入前你可以先看。
        </p>
        <textarea
          v-model="raw"
          class="ai-area"
          rows="7"
          placeholder="例：CUPED 用实验前的指标当协变量做回归调整，方差能降不少。注意协变量要选实验前就稳定的，别用被实验影响过的指标，否则会引入偏差……"
        />

        <div class="ai-acts">
          <button class="ai-primary" :disabled="!!busy" @click="doCompose">
            {{ busy === 'compose' ? '整理中…' : '✨ 整理并落位' }}
          </button>
          <span v-if="!isAiReady(cfg)" class="muted">还没填 Key，去「设置」</span>
        </div>

        <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

        <template v-if="result && result.blocks.length">
          <div class="ai-cand">
            <div class="ai-cand-head">
              <span class="ai-cand-title">{{ result.title }}</span>
              <span class="ai-cand-count">{{ result.blocks.length }} 块</span>
            </div>
            <label class="ai-pick">
              <span>落到</span>
              <select v-model="picked">
                <optgroup v-for="g in groups" :key="g.domain.id" :label="g.domain.name">
                  <option v-for="r in g.rows" :key="r.topic.id" :value="r.topic.id">
                    {{ '　'.repeat(r.depth) }}{{ r.topic.name }}
                  </option>
                </optgroup>
              </select>
            </label>
            <p class="ai-reason">
              <template v-if="result.reason">理由：{{ result.reason }}</template>
              <template v-else>当前挑的是 {{ pathOf(picked) }}</template>
            </p>
          </div>

          <div class="ai-preview">
            <BlockView v-for="b in result.blocks" :key="b.id" :block="b" />
          </div>

          <div class="ai-acts">
            <button class="ai-primary" @click="writeNote">写入新笔记</button>
            <button @click="result = null">放弃</button>
          </div>
        </template>
      </template>

      <!-- 问库里 -->
      <AiAsk v-else-if="tab === 'ask'" @close="emit('close')" @setup="tab = 'setup'" />

      <!-- 跨笔记 -->
      <AiCross v-else-if="tab === 'cross'" :open="open" @close="emit('close')" />

      <!-- 设置 -->
      <template v-else>
        <p class="ai-tip">
          支持任何 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / 智谱）。Key 只存在这台电脑的浏览器里，不会上传到任何地方。
        </p>

        <label class="ai-row">
          <span>接口地址</span>
          <input v-model.trim="cfg.base" placeholder="https://api.deepseek.com" />
        </label>
        <label class="ai-row">
          <span>模型</span>
          <input v-model.trim="cfg.model" placeholder="deepseek-flash" />
        </label>
        <label class="ai-row">
          <span>API Key</span>
          <input v-model.trim="cfg.key" type="password" placeholder="sk-..." />
        </label>
        <label class="ai-row">
          <span>思考模式</span>
          <input v-model="cfg.thinking" type="checkbox" true-value="on" false-value="off" />
        </label>

        <p class="ai-hint">
          DeepSeek 默认会先长篇思考再回答，写笔记时又慢又贵，所以默认关掉；只有难题才值得勾上。
          常用组合：DeepSeek 用 <code>https://api.deepseek.com</code> + <code>deepseek-flash</code>（便宜，够用），
          要更强的推理换 <code>deepseek-v4-pro</code>（约贵 4 倍）；OpenAI 用
          <code>https://api.openai.com/v1</code> + <code>gpt-4o-mini</code>。地址结尾会自动补
          <code>/chat/completions</code>。
        </p>

        <div class="ai-acts">
          <button class="ai-primary" @click="save">保存</button>
          <button :disabled="!!busy" @click="doPing('text')">
            {{ busy === 'ping' ? '测试中…' : '测试连接' }}
          </button>
          <button class="danger" @click="forget">清除 Key</button>
        </div>

        <p v-if="msg" class="ai-msg" :class="{ bad }">{{ msg }}</p>

        <p class="ai-sub">技能</p>
        <p class="ai-hint">
          技能只换「问库里」的回答套路，检索和引用规则不变。关掉的技能不会出现在提问框上方。
        </p>
        <div class="sk-list">
          <label v-for="s in SKILLS" :key="s.id" class="sk-row" :class="{ off: !isOn(s.id), fixed: !s.id }">
            <input type="checkbox" :checked="isOn(s.id)" :disabled="!s.id" @change="toggleSkill(s.id)" />
            <span class="sk-name">{{ s.name }}</span>
            <span class="sk-desc">{{ s.desc }}</span>
          </label>
        </div>

        <p class="ai-sub">自定义指令</p>
        <p class="ai-hint">
          每次问库里都会带上这段，优先级高于技能预设。写你希望它一直守的规矩，比如「别用『赋能』这类词」「答完一定给一个面试口径」。
        </p>
        <textarea
          v-model="extra"
          class="ai-area"
          rows="3"
          placeholder="例：回答里不要出现英文缩写，第一次出现时给中文全称"
        />
        <div class="ai-acts">
          <button @click="saveExtra">保存指令</button>
        </div>

        <p class="ai-sub">视觉模型（识图用，可选）</p>
        <p class="ai-hint">
          DeepSeek 看不了图。想把截图里的公式变成块，单独配一个能看图的模型：智谱
          <code>glm-4v-flash</code> 免费，填 <code>https://open.bigmodel.cn/api/paas/v4</code> 就行。
          没配也不影响其他功能，图片块照样能放。
        </p>
        <label class="ai-row">
          <span>接口地址</span>
          <input v-model.trim="cfg.vision.base" placeholder="https://open.bigmodel.cn/api/paas/v4" />
        </label>
        <label class="ai-row">
          <span>模型</span>
          <input v-model.trim="cfg.vision.model" placeholder="glm-4v-flash" />
        </label>
        <label class="ai-row">
          <span>API Key</span>
          <input v-model.trim="cfg.vision.key" type="password" placeholder="智谱的 key" />
        </label>
        <p class="ai-hint">视觉模型这套配置和上面分开存，换文本模型不会把它清掉。</p>
        <div class="ai-acts">
          <button :disabled="!!busy" @click="doPing('vision')">
            {{ busy === 'pvision' ? '测试中…' : '测试视觉模型' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
