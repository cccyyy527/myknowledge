// 「把一条回答存成笔记」的草稿处理：纯函数，面板和落库两边共用
import { SECTIONS, stripMark } from './ai.js'

// [n] 落到哪个块上，就把 refs 记在那个块里，渲染时才能点
const REF_RE = /\[\d+\]/
const REF_FIELDS = ['text', 'detail', 'answer', 'cause', 'avoid', 'term']

export const attachRefs = (blocks, refs) => {
  if (!refs.length) return blocks
  return blocks.map((b) => {
    const hit =
      REF_FIELDS.some((k) => REF_RE.test(b[k] || '')) ||
      (b.items || []).some((s) => REF_RE.test(s))
    return hit ? { ...b, refs } : b
  })
}

// AI 没判断出来时的兜底：整条回答就是一张问答卡
export const plainBlocks = (turn) => {
  if (!turn) return []
  const inside = stripMark(turn.a)
  const used = turn.used || []
  const src = used.length ? '\n\n来源：' + used.map((s, i) => `[${i + 1}] ${s.title}`).join('　') : ''
  const refs = used.map((s) => ({ id: s.id, title: s.title }))
  return [{ id: 'pv-qa', type: 'qa', question: turn.q, answer: (inside || '（空）') + src, refs }]
}

// 只给真有内容的段落加标题，预览里不出现空小节
export const groupBySection = (blocks) => {
  const out = []
  for (const sec of SECTIONS) {
    const items = blocks.filter((b) => (b.section || 'core') === sec.id)
    if (!items.length) continue
    out.push({ id: 'pv-h-' + sec.id, type: 'heading', level: 2, text: sec.title })
    out.push(...items)
  }
  return out
}

// 存进笔记前的统一清洗：去掉【库外】这类标记，块 id 全部换新
export const cleanBlocks = (list, newId) =>
  list.map((b) => {
    const { id, ...rest } = b
    for (const k of Object.keys(rest)) {
      if (typeof rest[k] === 'string') rest[k] = stripMark(rest[k])
      else if (Array.isArray(rest[k]))
        rest[k] = rest[k].map((x) => (typeof x === 'string' ? stripMark(x) : x))
    }
    return { id: newId(), ...rest }
  })
