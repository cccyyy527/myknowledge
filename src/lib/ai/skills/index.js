// skill 层：一份 skill 一个 md 文件，正文写文档、元信息写 frontmatter。
// 为什么不写在 JS 里：中文长段落塞进模板字符串要转义反引号和 ${}，
// 一份 skill 改起来会和别的 skill 混在同一个 diff 里；放进文件还能直接排版。
//
// 正文里两类占位符：
//   {{blockSpec}} / {{noFabricate}} 这类 —— 换成 schema.js、prompts.js 里的常量（见 VARS）
//   {{includes}}                    —— 换成 frontmatter 里 includes 列的那些 skill 的正文，
//                                      放在哪儿就在哪儿展开；不写就默认排在正文前面

import { str, BLOCK_SPEC, SECTION_SPEC, OUTSIDE_MARK } from '../schema.js'
import { NO_FABRICATE, NO_FABRICATE_WRITE } from '../prompts.js'

// 只在 schema.js / prompts.js 定义一次的常量，md 里用占位符引用，避免两处各写一遍
const VARS = {
  blockSpec: BLOCK_SPEC,
  sectionSpec: SECTION_SPEC,
  outside: OUTSIDE_MARK,
  noFabricate: NO_FABRICATE,
  noFabricateWrite: NO_FABRICATE_WRITE,
}

// 构建时把 md 原文打进 bundle：运行时没有网络请求，离线也能用。
// 认不出来的占位符原样留着，好在 prompt 里一眼看见写错了
const fill = (text) => str(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in VARS ? VARS[k] : m))

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

function splitFront(raw) {
  const text = str(raw)
  const m = FM_RE.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (!line.trim() || at < 0) continue
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: text.slice(m[0].length).trim() }
}

const listOf = (v) =>
  str(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const RAW = import.meta.glob('./*.md', { query: '?raw', import: 'default', eager: true })

export const SKILL_FILES = {}

for (const [file, raw] of Object.entries(RAW)) {
  const { meta, body } = splitFront(raw)
  const id = str(meta.id) || file.replace(/^.*\//, '').replace(/\.md$/, '')
  SKILL_FILES[id] = {
    id,
    kind: str(meta.kind) || 'task',
    scene: str(meta.scene) || 'qa',
    name: str(meta.name) || id,
    desc: str(meta.desc),
    includes: listOf(meta.includes),
    body: fill(body),
  }
}

// includes 先展开、自己后接：先是通用约定，再是这个场景特有的判断
// 正文里写 {{includes}} 可以指定展开位置（片段是给人读的，排在正文开头会打断前言）
function bodyOf(id, seen = new Set()) {
  const sk = SKILL_FILES[id]
  if (!sk || seen.has(id)) return ''
  seen.add(id)
  const inc = sk.includes.map((x) => bodyOf(x, seen)).filter(Boolean).join('\n\n')
  if (!sk.body.includes('{{includes}}')) return [inc, sk.body].filter(Boolean).join('\n\n')
  if (inc) return sk.body.replace('{{includes}}', inc)
  return sk.body.replace(/\n*\{\{includes\}\}\n*/, '\n').trim()
}

export const skillBody = (id) => bodyOf(str(id))
const ROLES = Object.values(SKILL_FILES).filter((s) => s.kind === 'role')

/* ---------- 角色技能：设置页里能选的那些 ---------- */

export const SKILLS = [
  { id: '', name: '默认', desc: '按库里的内容直接答，不额外扮演', system: '' },
  ...ROLES.map((s) => ({ id: s.id, name: s.name, desc: s.desc, system: bodyOf(s.id) })),
]

const KEY = 'myknowledge.skill'
const OFF_KEY = 'myknowledge.skill.off'

export const DEFAULT_PREF = { id: '', extra: '' }

export const skillById = (id) => SKILLS.find((s) => s.id === str(id)) || SKILLS[0]

// 「默认」永远在，其余技能允许在设置页关掉，免得技能列表越加越长
export function loadSkillOff() {
  try {
    const raw = JSON.parse(localStorage.getItem(OFF_KEY) || '[]')
    return Array.isArray(raw) ? raw.map((x) => str(x)) : []
  } catch {
    return []
  }
}

export function saveSkillOff(list) {
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify((list || []).map((x) => str(x))))
  } catch {}
}

export const enabledSkills = (off = loadSkillOff()) =>
  SKILLS.filter((s) => !s.id || !off.includes(s.id))

export function loadSkillPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREF }
    return {
      id: ROLES.some((s) => s.id === str(raw.id)) ? str(raw.id) : '',
      extra: str(raw.extra),
    }
  } catch {
    return { ...DEFAULT_PREF }
  }
}

export function saveSkillPref(patch = {}) {
  const cur = loadSkillPref()
  const next = { id: str(patch.id ?? cur.id), extra: str(patch.extra ?? cur.extra) }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  return next
}

/* ---------- 装配 ---------- */

// 统一装配点：本场景的 skill + 角色技能 + 调用方追加的规矩 + 用户自定义指令。
// 角色只挂在 scene 对得上的场景上 —— 归档、合并这些写入场景不带「出题官」这种身份，
// 否则那 150 字会和这一轮真正要做的事抢注意力
export function systemFor(id, { role, extra, append } = {}) {
  const task = SKILL_FILES[str(id)]
  if (!task) throw new Error(`没有这个 skill：${id}`)
  const parts = [bodyOf(task.id)]
  const rk = SKILL_FILES[str(role)]
  if (rk && rk.kind === 'role' && rk.scene === task.scene) parts.push(bodyOf(rk.id))
  if (str(append).trim()) parts.push(str(append).trim())
  // 用户自定义指令放最后，冲突时它的分量最重（用户自己写的话比预设更该听）。
  // role / extra 显式传过就不再读本地存储，方便测试里注入
  const pref = role === undefined && extra === undefined ? loadSkillPref() : { id: str(role), extra: str(extra) }
  const custom = str(pref.extra).trim()
  if (custom)
    parts.push(`用户自己定的规矩（优先级最高，和上面冲突时听这个）：\n${custom.slice(0, 800)}`)
  return parts.filter(Boolean).join('\n\n')
}
