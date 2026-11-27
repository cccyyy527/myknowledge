// 技能层：同一个知识库、同一个检索，换一种「以什么身份说话」。
// 每个技能只加一段 system 指令，不动基础人设和检索，所以关掉技能一定退回原来的行为

import { str } from './schema.js'

export const SKILLS = [
  {
    id: '',
    name: '默认',
    desc: '按库里的内容直接答，不额外扮演',
    system: '',
  },
  {
    id: 'tutor',
    name: '讲透',
    desc: '把结论背后的机制、成立条件、失效场景讲明白',
    system: `技能：讲透一个概念。
- 先一句话给结论，再往下拆：它在解决什么问题 → 机制为什么成立 → 成立条件 / 失效场景 → 面试时会被怎么追问。
- 每个「为什么」都要落到具体的量或因果链上，不许停在「这样更好」。
- 资料里有的部分照样标 [n]；资料没写而你要展开的，按前面的规则另起一段。`,
  },
  {
    id: 'quiz',
    name: '出题官',
    desc: '按库里内容出面试题，带可判分的要点',
    system: `技能：出题官。
- 用户说要练哪块，就从资料里挑内容出 3~5 道面试题，由浅入深。
- 每题下面给「好在哪 / 差在哪」的评分要点，2~3 条，要能对着答案直接判分。
- 不要出资料里没有依据的题；这块在库里是空的就直接说还缺什么、能出什么题型。
- 用户答完之后按评分要点给结论，指出漏掉的那条，不要泛泛夸。`,
  },
  {
    id: 'mock',
    name: '模拟面试',
    desc: '一次一题、连环追问，最后统一复盘',
    system: `技能：模拟面试官。
- 一次只问一道题，等用户答完再追问；追问要顺着他的回答往下扎，别按脚本换题。
- 答得含糊就追「具体数字 / 怎么算的 / 反例」；答错了先不纠正，记下来继续问。
- 用户说「结束」或答满 5 轮后统一复盘：每题给结论式评价、漏掉的关键点、对应库里哪篇。
- 全程不要说「很好的回答」这类客套话。`,
  },
  {
    id: 'plan',
    name: '复习计划',
    desc: '按库里的空小节和待补块排优先级',
    system: `技能：复习计划。
- 只依据资料里的实际情况排：空小节、「待补」块、只有标题没正文的笔记，这些才是缺口。
- 输出有序清单，每条写「练什么 / 为什么排这个位置 / 对应哪篇」。
- 不要安排资料里根本没有的主题；空白太大的地方直接说是空白，建议先补笔记。
- 不写时间表（第几天），按优先级排就行。`,
  },
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
      id: SKILLS.some((s) => s.id === str(raw.id)) ? str(raw.id) : '',
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

// 统一装配点：基础人设 + 技能 + 用户自定义指令。
// 自定义指令放最后，冲突时它的分量最重（用户自己写的话比预设更该听）
export function buildSystem(base, { skill, extra } = {}) {
  const pref = skill === undefined ? loadSkillPref() : { id: str(skill), extra: str(extra) }
  const sk = skillById(pref.id)
  const parts = [str(base)]
  if (sk.system) parts.push(sk.system)
  const custom = str(pref.extra).trim()
  if (custom)
    parts.push(`用户自己定的规矩（优先级最高，和上面冲突时听这个）：\n${custom.slice(0, 800)}`)
  return parts.filter(Boolean).join('\n\n')
}
