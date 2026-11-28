// L3 问答：只带着检索出来的材料回答，不碰知识库

import { buildContext } from '../retrieve.js'
import { chatStream } from './client.js'
import { str } from './schema.js'
import { systemFor } from './skills/index.js'

/* ---------- L3：问整个知识库 ---------- */

// 历史只带结论、不带过程：一条回答几千字原样塞回去，几轮就把上下文吃光了
// 只留最近几轮全文；更早的不整段扔掉，压成一行话题索引塞回去 ——
// 用户爱用「那它呢」这种追问，老问题全丢光模型就不知道「它」指谁了
export const trimHistory = (history = [], limit = 6, maxChars = 1500) => {
  const older = history.slice(0, Math.max(0, history.length - limit))
  const recent = history.slice(-limit).map((m) => {
    const c = str(m.content)
    const over = m.role === 'assistant' && c.length > maxChars
    return { role: m.role, content: over ? `${c.slice(0, maxChars)}…（后略）` : c }
  })
  const asks = older
    .filter((m) => m.role === 'user')
    .map((m) => str(m.content).replace(/\s+/g, ' ').slice(0, 40))
  if (!asks.length) return recent
  return [
    { role: 'user', content: `（更早还问过这些，只记得题目：${asks.join(' / ')}）` },
    { role: 'assistant', content: '好，这些话题我还记得，需要时可以直接接着问。' },
    ...recent,
  ]
}

export async function askLibrary({
  question,
  history = [],
  cfg,
  strict = false,
  skill,
  extra,
  onDelta,
  onThink,
  signal,
} = {}) {
  // 追问「那它的假设是什么」里没有关键词，只按这一句检索会漏到别的笔记上；
  // 把上一轮的问题也带上（只算半票），当前这句仍然是主角
  const prevQ = [...history].reverse().find((m) => m.role === 'user')?.content || ''
  const { empty, text: ctx, used, fallback } = buildContext(question, { extra: prevQ })
  if (empty) throw new Error('库里还没有笔记，先写一篇再来问')

  const head = fallback
    ? `资料（没有明显命中，下面是最近改过的几篇；如果都不相关就直说库里没有）：`
    : `资料（从用户知识库里检索出来的 ${used.length} 篇）：`
  // 资料是数据不是指令，放在最末：前面是人设和规矩，最后才给这一轮要读的材料
  const sys = systemFor(strict ? 'answer-strict' : 'answer', { role: skill, extra })
  const messages = [
    { role: 'system', content: `${sys}\n\n${head}\n${ctx}` },
    ...trimHistory(history),
    { role: 'user', content: question },
  ]

  const text = await chatStream(messages, {
    cfg,
    temperature: strict ? 0.1 : 0.2,
    maxTokens: 1600,
    onDelta,
    onThink,
    signal,
  })
  return { text, used, fallback, strict }
}
