// 分类树：给模型看的目录、id 校验、兜底分类

import { state } from '../store.js'

/* ---------- 分类树 ---------- */

// 给模型看的精简目录：d1 是域，t-xxx 是分类，缩进表示层级
export function topicCatalog() {
  const lines = []
  const walk = (domainId, depth) => {
    const kids = state.topics.filter((t) => t.domainId === domainId && t.parentId)
    const roots = state.topics.filter((t) => t.domainId === domainId && !t.parentId)
    const emit = (list, d) => {
      for (const t of list) {
        lines.push(`${'  '.repeat(d)}${t.id} ${t.name}`)
        emit(kids.filter((k) => k.parentId === t.id), d + 1)
      }
    }
    emit(roots, depth)
  }
  for (const d of state.domains) {
    lines.push(`${d.id} ${d.name}`)
    walk(d.id, 1)
  }
  return lines.join('\n')
}

export const topicExists = (id) => state.topics.some((t) => t.id === id)

// 推荐分类不可用时的兜底：该域第一个叶子
export function fallbackTopicId() {
  const leaf = state.topics.find(
    (t) => !state.topics.some((o) => o.parentId === t.id),
  )
  return leaf ? leaf.id : state.topics[0]?.id || ''
}
