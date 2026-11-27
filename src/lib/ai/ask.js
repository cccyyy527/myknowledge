// L3 问答：只带着检索出来的材料回答，不碰知识库

import { buildContext } from '../retrieve.js'
import { chatStream } from './client.js'
import { str, OUTSIDE_MARK } from './schema.js'
import { NO_FABRICATE } from './prompts.js'
import { buildSystem } from './skills.js'

/* ---------- L3：问整个知识库 ---------- */

// 历史只带结论、不带过程：一条回答几千字原样塞回去，几轮就把上下文吃光了
export const trimHistory = (history = [], limit = 6, maxChars = 1500) =>
  history.slice(-limit).map((m) => {
    const c = str(m.content)
    const over = m.role === 'assistant' && c.length > maxChars
    return { role: m.role, content: over ? `${c.slice(0, maxChars)}…（后略）` : c }
  })

const ASK_SYSTEM = `你是这个私人知识库的问答助手。用户是准备数据分析 / AB 实验 / 因果推断面试的人，库里是他自己写的笔记。

规则：
- 先依据「资料」回答。来自资料的每条具体结论后面标来源，写成 [1]、[2]，编号必须是资料里出现过的编号。
- 资料里没有、但你确实知道的内容，另起一段，段首单独占一行写「${OUTSIDE_MARK}」，后面全是这部分内容。这个标记是给程序切段用的，渲染时会被自动去掉：不要解释它、不要在同一段里重复它、更不要把它写进要存档的正文里。没有这类内容就不要写这一段。
- 回答里除了 [n] 和 [[标题]] 这两种引用，不要再出现别的方括号标记、标签或前缀。
- 资料里没有、你也拿不准的，直接说「库里还没有」，再补一句最接近的是哪一篇、还缺什么。
- ${NO_FABRICATE}
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。
- 用户问「有哪些 / 列一下」时，把资料里相关的都列出来，一条一行，每条都带来源。
- 用户的笔记互相矛盾时，指出来是哪两篇、分别怎么写的，不要替他和稀泥。`

// 只查笔记模式：一个字都不许超出资料，面试前怕被带偏时用
const ASK_STRICT = `你是这个私人知识库的问答助手。用户是准备数据分析 / AB 实验 / 因果推断面试的人，库里是他自己写的笔记。

规则：
- 只能依据「资料」回答。每条具体结论后面标来源，写成 [1]、[2]，编号必须是资料里出现过的编号。
- 资料里没写的，直接说「库里还没有」，再说最接近的是哪一篇、还缺什么，然后就停。
- 禁止用你自己的通用知识补充，禁止写「${OUTSIDE_MARK}」段落，禁止编造数字、论文名、公司案例。
- 中文，先给结论再给依据，尽量短。可以用「- 」列表和 **粗体**，不要用 # 标题、不要用表格。
- 用户问「有哪些 / 列一下」时，把资料里相关的都列出来，一条一行，每条都带来源。`

export async function askLibrary({
  question,
  history = [],
  cfg,
  strict = false,
  skill,
  extra,
  onDelta,
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
  const base = strict ? ASK_STRICT : ASK_SYSTEM
  const messages = [
    { role: 'system', content: buildSystem(`${base}\n\n${head}\n${ctx}`, { skill, extra }) },
    ...trimHistory(history),
    { role: 'user', content: question },
  ]

  const text = await chatStream(messages, {
    cfg,
    temperature: strict ? 0.1 : 0.2,
    maxTokens: 1600,
    onDelta,
    signal,
  })
  return { text, used, fallback, strict }
}
