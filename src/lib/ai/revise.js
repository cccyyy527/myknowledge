// 整篇改写：先算一份结构诊断，模型只输出操作列表，落库前再按块 id 校验一遍

import { newBlockId, state } from '../store.js'
import { searchNotes, blockText } from '../retrieve.js'
import { chat, pickJson } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, str, arr, normalizeBlocks, assembleBlocks } from './schema.js'
import { NO_FABRICATE_WRITE } from './prompts.js'

/* ---------- 段落归属 ---------- */

const TYPE_NAME = {
  paragraph: '段落',
  definition: '概念卡',
  formula: '公式',
  comparison: '对比',
  qa: '问答',
  pitfall: '坑',
  steps: '步骤',
  callout: '提示',
  bulletList: '列表',
  code: '代码',
  todo: '占位',
}

const squash = (v) => str(v).replace(/[\s\u3000·:：,，、/|()（）[\]【】<>《》\-—_]+/g, '')

// 标题 → 段 id：先精确、再互相包含（用户把「推导 / 细节」改成「推导」也能认出来）
const sectionByTitle = (text) => {
  const t = squash(text)
  if (!t) return ''
  const hit = SECTIONS.find((s) => squash(s.title) === t)
  if (hit) return hit.id
  const loose = SECTIONS.find((s) => squash(s.title).includes(t) || t.includes(squash(s.title)))
  return loose ? loose.id : ''
}

// 块属于哪一段：以 heading 为界；标题被手动改过就按第几个 heading 落位，别整篇错段
export function sectioned(note) {
  const out = []
  let cur = SECTIONS[0].id
  let nth = 0
  for (const b of note?.blocks || []) {
    if (b.type === 'heading' && (b.level || 2) === 2) {
      cur = sectionByTitle(b.text) || SECTIONS[Math.min(nth, SECTIONS.length - 1)].id
      nth++
      continue
    }
    out.push({ section: cur, block: b })
  }
  return out
}

const sectionsOf = (note) => new Map(sectioned(note).map((r) => [r.block.id, r.section]))

const blockKey = (b) =>
  squash(b.text || b.term || b.question || b.answer || b.latex || (b.items || [])[0] || '')

/* ---------- 结构诊断：模型自己看不出笔记哪里歪了，程序先算给它 ---------- */

export function diagnose(note) {
  const rows = sectioned(note)
  const total = rows.length
  const sections = SECTIONS.map((s) => {
    const items = rows.filter((r) => r.section === s.id).map((r) => r.block)
    const types = {}
    for (const b of items) types[b.type] = (types[b.type] || 0) + 1
    return { id: s.id, title: s.title, count: items.length, types }
  })

  const flags = []
  const empty = sections.filter((s) => !s.count).map((s) => s.title)
  if (empty.length) flags.push(`空段：${empty.join('、')} —— 一个字都没有`)

  const qa = sections.find((s) => s.id === 'qa')
  if (qa && !qa.count) flags.push('一个问答卡都没有 —— 这篇还不能直接拿来练面试')
  const pf = sections.find((s) => s.id === 'pitfall')
  if (pf && !pf.count) flags.push('没有坑卡 —— 没写自己真踩过什么')

  const contiguous = (types) => {
    const hits = []
    let run = 1
    for (let i = 1; i <= types.length; i++) {
      if (i < types.length && types[i] === types[i - 1]) {
        run++
        continue
      }
      if (run >= 3) hits.push({ type: types[i - 1], n: run })
      run = 1
    }
    return hits
  }
  for (const s of sections) {
    const items = rows.filter((r) => r.section === s.id).map((r) => r.block.type)
    for (const h of contiguous(items))
      flags.push(`${s.title} 里连着 ${h.n} 个${TYPE_NAME[h.type] || h.type} —— 多半该合并成一张卡，或者拆进别的段`)
  }

  const seen = new Map()
  const dupes = []
  for (const r of rows) {
    const k = blockKey(r.block).slice(0, 24)
    if (!k) continue
    if (seen.has(k)) dupes.push({ a: seen.get(k).id, b: r.block.id, why: k.slice(0, 16) })
    else seen.set(k, r.block)
  }
  if (dupes.length) flags.push(`${dupes.length} 组块开头一模一样 —— 可能是重复块`)

  const long = rows.filter((r) => {
    const t = str(r.block.text || r.block.answer)
    return t.length > 320 && !t.includes('\n')
  })
  if (long.length) flags.push(`${long.length} 块超过 320 字还是一次写到尾 —— 该拆成几块`)

  for (const s of sections) {
    if (!s.count) continue
    if (s.id === 'qa' && s.types.qa !== s.count)
      flags.push(`「高频问法」里有 ${s.count - (s.types.qa || 0)} 块不是问答卡 —— 大概放错段了`)
    if (s.id === 'pitfall' && s.types.pitfall !== s.count)
      flags.push(`「我踩过的坑」里有 ${s.count - (s.types.pitfall || 0)} 块不是坑卡 —— 大概放错段了`)
  }

  const text = [
    `全篇 ${total} 块。分段：`,
    ...sections.map(
      (s) =>
        `- ${s.title}（${s.id}）：${s.count} 块` +
        (s.count
          ? '，' + Object.entries(s.types).map(([t, n]) => `${TYPE_NAME[t] || t}×${n}`).join(' ')
          : ''),
    ),
    flags.length ? `\n结构问题：\n${flags.map((f) => '- ' + f).join('\n')}` : '\n结构上没看出明显问题。',
  ].join('\n')

  return { total, sections, flags, dupes, text }
}

/* ---------- 让模型出改动 ---------- */

// 改一篇时不该闭着眼：把库里相邻的几篇摘要塞进 prompt，模型才知道哪句该指过去、哪句跟别人说法打架
export function relatedNotes(note, { limit = 5 } = {}) {
  if (!note) return []
  const heads = (note.blocks || [])
    .filter((b) => b.type === 'heading' && b.level === 2)
    .map((b) => str(b.text))
  const probe = [note.title, ...(note.tags || []), ...heads].filter(Boolean).join(' ')
  const extra = (note.blocks || [])
    .filter((b) => b.type !== 'heading')
    .slice(0, 8)
    .map((b) => blockText(b))
    .join(' ')
  if (!probe.trim()) return []
  return searchNotes(probe, { limit: limit + 4, extra })
    .filter((x) => x.id !== note.id)
    .slice(0, limit)
    .map((x) => {
      const full = state.notes.find((n) => n.id === x.id)
      const bits = (full?.blocks || [])
        .filter((b) => b.type !== 'heading')
        .map((b) => blockText(b).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const text = bits
        .slice(0, 4)
        .map((t) => (t.length > 110 ? `${t.slice(0, 110)}…` : t))
        .join(' / ')
      return { id: x.id, title: x.title, path: x.path, text }
    })
}

const REVISE_SYSTEM = `你在改一篇数据分析面试知识笔记。用户会给你现有内容、程序算出的结构诊断、以及想要的改动。

${BLOCK_SPEC}
${SECTION_SPEC}

能做的事（不只是改错字）：
- keep    原样保留
- move    把块挪到别的段（结构问题多半是块放错了段）
- replace 改写已有块，type 也可以换（比如两个 paragraph 合成一张 definition）
- add     新增块
- drop    删掉已有块

输出格式，按最终顺序列出：
- 连续的 keep 合并成一条：{"op":"keep","ids":["b-x","b-y"]}
- {"op":"move","id":"b-x","section":"detail"}
- {"op":"replace","id":"b-x","block":{"type":"...", ...块字段}}
- {"op":"add","section":"core","block":{...}}
- {"op":"drop","id":"b-x"}

同一段内块的先后顺序 = 你输出 ops 的顺序，想调顺序就调 ops 的顺序。

规则：
- 先读结构诊断再动手。诊断点出来的空段、连续同类型、重复块、放错段，都可以直接处理。
- 但 keep / move 的块文字必须一字不改 —— 不许顺手润色、不许改措辞。想改文字就走 replace，让用户在面板上看得见。
- 允许重排、允许合并同类块、允许把过长的块拆成几块。
- 库里相邻的笔记只给了摘要，用来做两件事：① 那边已经写透的结论，这篇别再造一遍，确实相关就在块里用 [[笔记完整标题]] 指过去（标题一字不差，写错就跳不过去）；② 这篇跟相邻笔记说法不一致时，不要自己挑一个，写进 advice 留给用户判断。
- ${NO_FABRICATE_WRITE}
- 不要输出 heading 块，段落由 section 字段决定。
- title 只在指令明确要求改标题时才给，否则省略这个字段。
- advice 只有一句话：跨笔记那部分值得用户注意的事（该指过去的、说法冲突的）。没有就省略。
只输出一个 JSON 对象：{"title":"...","advice":"...","ops":[...]}`

export async function reviseNote({ note, instruction, cfg, related } = {}) {
  const cur = sectioned(note).map((r) => ({ ...r.block, section: r.section }))
  const rel = related === undefined ? relatedNotes(note) : arr(related)
  const relText = rel.length
    ? rel
        .map(
          (r, i) =>
            `${i + 1}. 《${r.title}》（${r.path || '未归类'}）${r.text ? `：${r.text}` : '（这篇还是空的）'}`,
        )
        .join('\n')
    : '（库里没有明显相邻的笔记，这篇可以独立成篇）'

  const user = `笔记标题：${note?.title || ''}

结构诊断（程序算的，比肉眼准）：
${diagnose(note).text}

库里相邻的笔记：
${relText}

现有块（id 要原样引用）：
${JSON.stringify(cur)}

想要的改动：${instruction}`

  const text = await chat(
    [
      { role: 'system', content: REVISE_SYSTEM },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.3, maxTokens: 8000 },
  )
  const data = pickJson(text)
  return {
    title: str(data.title),
    advice: str(data.advice),
    related: rel,
    ops: normalizeOps(data.ops || data.blocks, note),
  }
}

/* ---------- 把模型返回的 ops 掰正 ---------- */

// 模型可能给不存在的 id、把 add 当 replace、重复同一个块、挪到不存在的段，这里全部掰正
export function normalizeOps(raw, note) {
  const all = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const secOf = sectionsOf(note)
  const seen = new Set()
  const out = []

  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue
    let op = ['keep', 'move', 'replace', 'add', 'drop'].includes(item.op) ? item.op : ''
    const id = str(item.id)

    if (op === 'keep') {
      const ids = arr(item.ids).length ? arr(item.ids).map(str) : [id]
      for (const one of ids) {
        if (!all.has(one) || seen.has(one)) continue
        seen.add(one)
        out.push({ op: 'keep', id: one, block: all.get(one) })
      }
      continue
    }

    if (op === 'move') {
      const section = SECTIONS.some((s) => s.id === item.section) ? item.section : ''
      if (!all.has(id) || seen.has(id) || !section || section === secOf.get(id)) continue
      seen.add(id)
      out.push({ op: 'move', id, section, block: all.get(id), oldSection: secOf.get(id) })
      continue
    }

    if (op === 'drop') {
      if (!all.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ op: 'drop', id, block: all.get(id) })
      continue
    }

    if (op === 'replace') {
      if (!all.has(id) || seen.has(id)) op = 'add'
      else seen.add(id)
    }
    if (!op) op = id && all.has(id) ? 'replace' : 'add'
    // 块内容模型有时放在 block 里、有时直接平铺在这一层
    const inner = item.block && typeof item.block === 'object' ? item.block : item
    // 改写没给 section 就留在原段，别让整块悄悄跑到「核心结论」
    const section = str(item.section) || str(inner.section) || (op === 'replace' ? secOf.get(id) : '')
    const [b] = normalizeBlocks([{ ...inner, section }])
    if (!b) continue
    const { id: _tmp, ...rest } = b
    if (op === 'replace') out.push({ op, id, section: b.section, block: rest, old: all.get(id) })
    else out.push({ op: 'add', section: b.section, block: rest })
  }
  return out
}

// 空段落不留在笔记里：heading 后面没块就别显示
const compact = (list) => {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const b = list[i]
    const next = list[i + 1]
    if (b.type === 'heading' && b.level === 2 && (!next || next.type === 'heading')) continue
    out.push(b)
  }
  return out
}

// 按用户勾过的行改写笔记；heading 由 assembleBlocks 重新生成。
// 顺手记一份 marks（块 id → 改/移/新），预览版靠它给成品上色；drop 掉的块不可能出现在成品里，另开一个集合
export function applyOps(note, rows) {
  const marks = new Map()
  const dropped = new Set()
  if (!note) return { marks, dropped }
  const secOf = sectionsOf(note)
  const byId = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const items = []
  const done = new Set()
  const push = (section, block) => items.push({ ...block, section: section || 'core' })

  for (const r of rows) {
    if (r.op === 'keep') {
      const b = byId.get(r.id)
      if (b && !done.has(r.id)) {
        done.add(r.id)
        push(secOf.get(r.id), b)
      }
    } else if (r.op === 'move') {
      const b = byId.get(r.id)
      if (!b || done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) marks.set(r.id, 'move')
      push(r.checked ? r.section : secOf.get(r.id), b)
    } else if (r.op === 'replace') {
      if (done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) {
        marks.set(r.id, 'replace')
        push(r.section, { ...r.block, id: r.id })
      } else push(secOf.get(r.id), byId.get(r.id))
    } else if (r.op === 'add') {
      if (r.checked) {
        const id = newBlockId()
        push(r.section, { ...r.block, id })
        marks.set(id, 'add')
      }
    } else if (r.op === 'drop') {
      if (r.checked) {
        done.add(r.id)
        dropped.add(r.id)
      }
    }
  }
  // 模型漏掉的原块按原样留住，别悄悄吃掉用户写的东西
  for (const [id, b] of byId) {
    if (done.has(id)) continue
    push(secOf.get(id), b)
  }
  note.blocks = compact(assembleBlocks(items))
  return { marks, dropped }
}
