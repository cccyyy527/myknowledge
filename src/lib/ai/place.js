// 写入前的程序把关：查重 / 落点 / 写完复核
// 光在 prompt 里写「别重复」没用：模型看不到别篇里已经写了什么，也没法把整库跟这次内容逐一比对。
// 这里把能算的算出来，再让模型只回答「同不同一件事」这种判断题，最后把结果复核一遍摆给用户看。

import { liveNoteById } from '../store.js'
import { searchNotes, noteText, blockText as flatBlock, noteBrief } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import { arr, str, secTitle, SECTIONS } from './schema.js'
import { dupCandidates, pairScore, flatOf } from './block-edit.js'

const MAX_CANDS = 3
const PACK_BUDGET = 2600

const textOfBlocks = (blocks) =>
  arr(blocks)
    .map((b) => flatBlock(b))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

const labelOf = (b) => {
  const raw = str(b?.text || b?.term || b?.question || b?.answer || b?.latex || (b?.items || [])[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.length > 18 ? `${raw.slice(0, 18)}…` : raw
}

// 库里哪几篇跟这次内容最沾边：直接用检索那套打分，不另造一套判据
export function rankTargets(blocks, { excludeId = '', limit = MAX_CANDS } = {}) {
  const q = textOfBlocks(blocks)
  if (q.length < 4) return []
  return searchNotes(q.slice(0, 400), { limit: limit + 1 })
    .filter((h) => h.id !== excludeId)
    .slice(0, limit)
}

// 候选笔记的正文：带块 id，模型才能说清「跟哪一块重了」
function packCands(cands) {
  const each = Math.max(500, Math.floor(PACK_BUDGET / Math.max(1, cands.length)))
  const out = []
  cands.forEach((c, i) => {
    const note = liveNoteById(c.id)
    if (!note) return
    const body = noteText(note, { ids: true, budget: each }).split('\n').slice(1).join('\n')
    out.push(
      `C${i + 1}《${note.title}》（noteId: ${note.id}｜${c.path || '未归类'}｜` +
        `${c.empty ? '空笔记，只有小节标题' : `已有 ${c.count} 块`}）\n${body || '（正文为空）'}`,
    )
  })
  return out.join('\n\n')
}

const JUDGE_SYSTEM = `你在校对一个人的数据分析面试知识库。用户要把下面这批新块写进去，你只做两件判断，别的什么都不做。

判断 A（查重）：新块和候选笔记里已有的块，是不是在讲同一件事。
- same：同一件事，只是措辞不同。例：「按 99.5% 分位缩尾」和「对极端值做截断」是同一件事；「σ² 越大样本越多」和「方差决定样本量」也是。
- part：有重叠，但新块确实多说了东西——该并进那一块，而不是在它旁边再加一块。
- diff：两件事。diff 的那条不要输出。

判断 B（落点）：这批新块最该写进候选里的哪一篇。
- 有一篇的标题能概括整批内容、里面已经有相关上下文 → 填它的 noteId。
- 当前目标本身就合适 → 填当前目标的 noteId。
- 候选都不贴、确实是库里还没有的新主题 → 填 ""，why 写「该新建」。

只输出一个 JSON 对象，不要解释、不要 markdown、不要代码块：
{"dup":[{"n":1,"c":2,"v":"same","why":"12字以内"}],"place":{"noteId":"...","why":"20字以内"}}
n 是新块编号（N 后面的数），c 是候选编号（C 后面的数）。没把握的别硬判，宁可不输出那一条。`

// 模型判完要落到具体块上：让它再报块 id 等于多一个出错点，直接在那一篇里找最像的
function closestIn(note, flat) {
  let best = null
  for (const b of note?.blocks || []) {
    if (b.type === 'heading') continue
    const t = flatOf(b)
    if (!t) continue
    const sim = pairScore(flat, t)
    if (!best || sim > best.sim) best = { block: b, sim }
  }
  return best
}

/**
 * 把这次要写的块跟库里比一遍。
 * 返回 { dup, place, cands, failed }：
 * - dup：{ i, block, v: 'same' | 'part', why, note, old } —— v=same 该打回让模型改写已有块
 * - place：{ noteId, why } —— 模型认为更合适的落点（等于当前目标时也照实返回）
 */
export async function reviewWrite({ blocks, chosenId = '', cfg, signal } = {}) {
  const list = arr(blocks)
  const blank = { dup: [], place: null, cands: [], failed: false }
  if (!list.length) return blank

  const chosen = chosenId ? liveNoteById(chosenId) : null
  // 目标这篇里已经有近似块：说明是「换个说法再说一遍」，值得让模型判一下
  const near = chosen ? dupCandidates(chosen, list) : []
  const targets = rankTargets(list, { excludeId: chosenId })
  // 库里既没有别的近似篇，目标里也没有近似块：没有可比的东西，别浪费一次请求
  if (!targets.length && !near.length) return { ...blank, cands: chosen ? [noteBrief(chosen, 0)] : [] }

  const cands = []
  if (chosen) cands.push(noteBrief(chosen, 0))
  for (const t of targets) if (!cands.some((c) => c.id === t.id)) cands.push(t)
  const used = cands.slice(0, MAX_CANDS)

  const newLines = list.map(
    (b, i) => `N${i + 1}（${b.section || 'core'} · ${b.type}）${flatBlock(b).slice(0, 320)}`,
  )
  const who = chosen ? `《${chosen.title}》（noteId: ${chosen.id}）` : '新建一篇'
  const user = `新块：\n${newLines.join('\n')}\n\n候选笔记：\n${packCands(used)}\n\n当前目标：${who}`

  let data
  try {
    const text = await chat(
      [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: user },
      ],
      { cfg, temperature: 0, maxTokens: 900, signal },
    )
    data = pickJson(text)
  } catch (e) {
    // 判重失败不该拦住写入：退回「只有字面命中才算重复」的老行为
    if (e.name === 'AbortError') throw e
    return { dup: [], place: null, cands: used, failed: true }
  }

  const dup = []
  for (const row of arr(data?.dup)) {
    const i = Number(row?.n) - 1
    const c = Number(row?.c) - 1
    const block = list[i]
    const cand = used[c]
    if (!block || !cand) continue
    const v = str(row.v)
    if (v !== 'same' && v !== 'part') continue
    const note = liveNoteById(cand.id)
    const hit = note ? closestIn(note, flatOf(block)) : null
    dup.push({
      i,
      block,
      v,
      why: str(row.why).slice(0, 40),
      note: note ? { id: note.id, title: note.title } : null,
      old: hit && hit.sim > 0.2 ? hit.block : null,
    })
  }

  // 落点必须是它真见过的 id：模型偶尔会编一个不存在的 noteId 回来
  const pid = str(data?.place?.noteId)
  const known = pid && (pid === chosenId || used.some((c) => c.id === pid))
  const place = known ? { noteId: pid, why: str(data?.place?.why).slice(0, 60) } : null

  return { dup, place, cands: used, failed: false }
}

// 语义判重的打回话术：和字面判重不同，这里要顺带说清「去哪一篇改」
export function sameIssue(dups, chosenId = '') {
  const rows = dups.map((d) => {
    const where = d.note ? `《${d.note.title}》` : '这篇'
    const at = d.old ? `[#${d.old.id}]「${labelOf(d.old)}」` : '已写过的内容'
    return `- 新块 N${d.i + 1}「${labelOf(d.block)}」＝ ${where}里的 ${at}${d.why ? `（${d.why}）` : ''}`
  })
  const other = dups.find((d) => d.note && d.note.id !== chosenId)
  const tail = other
    ? `\n那些内容不在这次的目标笔记里：先把 noteId 指到《${other.note.title}》，再用 mode=edit 落在已有那块上（op=replace 改写那句、op=insert 在这块后面补一小块）。`
    : '\n改成 mode=edit 落在已有那块上：段落放错用 op=move，说法要更新用 op=replace 给全改写后的整块，确实要多说一层就用 op=insert 在这块后面补一小块，别把已有的句子再抄一遍。'
  return `库里已经有同一件事了，换个说法再写一遍就是重复：\n${rows.join('\n')}\n${tail}`
}

/**
 * 落库前的复核：这批块写进去之后，这篇会变成什么样。
 * 不是拦截，是摆在面板上让用户一眼看见——程序能算出来的问题，没必要等他自己通读一遍才发现。
 */
export function writeChecks(blocks, { note = null, soft = [] } = {}) {
  const out = []
  const list = arr(blocks)
  if (!list.length) return out

  for (const x of soft) {
    const where = x.note ? `《${x.note.title}》` : '这篇'
    out.push({
      level: 'warn',
      text: `N${x.i + 1} 跟${where}已有的内容部分重叠${x.why ? `（${x.why}）` : ''}，多半该并进那一块而不是在旁边再加一块。`,
    })
  }

  const wrong = list.filter((b) => {
    const sec = b.section || 'core'
    return (sec === 'qa' && b.type !== 'qa') || (sec === 'pitfall' && b.type !== 'pitfall')
  })
  if (wrong.length)
    out.push({
      level: 'warn',
      text: `有 ${wrong.length} 块的段落和类型对不上（${[...new Set(wrong.map((b) => secTitle(b.section)))].join('、')}）——落库后这些段会混进不属于它的块。`,
    })

  const long = list.filter((b) => {
    const t = str(b.text || b.answer)
    return t.length > 320 && !t.includes('\n')
  })
  if (long.length) out.push({ level: 'warn', text: `${long.length} 块超过 320 字还是一整段，手机上读不动，建议拆成几块。` })

  const secs = new Set(list.map((b) => b.section || 'core'))
  if (list.length >= 4 && secs.size === 1) {
    const only = [...secs][0]
    const rest = SECTIONS.filter((s) => s.id !== only).map((s) => s.title)
    out.push({ level: 'info', text: `${list.length} 块全落在「${secTitle(only)}」，${rest.join('、')} 还是空的，确认一下是不是该拆开。` })
  }

  if (list.length > 12) out.push({ level: 'info', text: `这次要加 ${list.length} 块，已经是一篇完整笔记的量，可以考虑拆成两篇。` })

  if (note && list.length >= 3) {
    const has = new Set([...(note.blocks || []).map((b) => b.type), ...list.map((b) => b.type)])
    if (!has.has('qa')) out.push({ level: 'info', text: '这篇写进去还是没有问答卡，面试前没法直接拿来练。' })
  }
  return out.slice(0, 6)
}
