// 整篇改写：模型只输出操作列表，落库前再按块 id 校验一遍

import { newBlockId } from '../store.js'
import { chat, pickJson } from './client.js'
import { SECTIONS, BLOCK_SPEC, SECTION_SPEC, str, arr, normalizeBlocks, assembleBlocks } from './schema.js'

/* ---------- 整篇改写：把笔记当一份稿子重排 ---------- */

// 块属于哪一段：靠前面的 heading 推
export function sectioned(note) {
  const out = []
  let cur = SECTIONS[0].id
  for (const b of note?.blocks || []) {
    if (b.type === 'heading' && b.level === 2) {
      const hit = SECTIONS.find((s) => s.title === b.text)
      if (hit) cur = hit.id
      continue
    }
    out.push({ section: cur, block: b })
  }
  return out
}

const sectionsOf = (note) => new Map(sectioned(note).map((r) => [r.block.id, r.section]))

const REVISE_SYSTEM = `你在改一篇数据分析面试知识笔记的结构。用户会给你现有内容和想要的改动。

${BLOCK_SPEC}
${SECTION_SPEC}

规则：
- 按最终顺序列出所有块，每个块带一个 op：
  keep    原样保留，只需给 id
  replace 改写已有块，给 id + block（新内容，type 可以换）
  add     新增块，给 section + block
  drop    删掉已有块，只需给 id
- block 里放块字段（type + BLOCK_SPEC 里对应的字段），section 放在 op 这一层。
- 指令没提到的块一律 keep，不要顺手润色、不要改变顺序。
- 不要编造具体数字、论文名、公司案例；缺信息就写 todo 块占位。
- 不要输出 heading 块，段落由 section 字段决定。
- title 只在指令明确要求改标题时才给，否则省略这个字段。
只输出一个 JSON 对象：{"title":"...","ops":[{"op":"keep","id":"..."},{"op":"add","section":"core","block":{"type":"paragraph","text":"..."}}]}`

export async function reviseNote({ note, instruction, cfg } = {}) {
  const cur = sectioned(note).map((r) => ({ ...r.block, section: r.section }))
  const user = `笔记标题：${note?.title || ''}

现有块（id 要原样引用）：
${JSON.stringify(cur)}

想要的改动：${instruction}`

  const text = await chat(
    [
      { role: 'system', content: REVISE_SYSTEM },
      { role: 'user', content: user },
    ],
    { cfg, temperature: 0.3, maxTokens: 4000 },
  )
  const data = pickJson(text)
  return {
    title: str(data.title),
    ops: normalizeOps(data.ops || data.blocks, note),
  }
}

// 模型可能给不存在的 id、把 add 当 replace、重复同一个块，这里全部掰正
export function normalizeOps(raw, note) {
  const all = new Map(sectioned(note).map((r) => [r.block.id, r.block]))
  const seen = new Set()
  const out = []
  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue
    const id = str(item.id)
    let op = ['keep', 'replace', 'add', 'drop'].includes(item.op) ? item.op : ''
    if (!op) op = id && all.has(id) ? 'replace' : 'add'

    if (op === 'keep' || op === 'drop') {
      if (!all.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ op, id, block: all.get(id) })
      continue
    }
    if (op === 'replace') {
      if (!all.has(id) || seen.has(id)) op = 'add'
      else seen.add(id)
    }
    // 块内容模型有时放在 block 里、有时直接平铺在这一层
    const inner = item.block && typeof item.block === 'object' ? item.block : item
    const section = str(item.section) || str(inner.section)
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

// 按用户勾过的行改写笔记；heading 由 assembleBlocks 重新生成
export function applyOps(note, rows) {
  if (!note) return
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
    } else if (r.op === 'replace') {
      if (done.has(r.id)) continue
      done.add(r.id)
      if (r.checked) push(r.section, { ...r.block, id: r.id })
      else push(secOf.get(r.id), byId.get(r.id))
    } else if (r.op === 'add') {
      if (r.checked) push(r.section, { ...r.block, id: newBlockId() })
    } else if (r.op === 'drop') {
      if (r.checked) done.add(r.id)
    }
  }
  // 模型漏掉的原块按原样留住，别悄悄吃掉用户写的东西
  for (const [id, b] of byId) {
    if (done.has(id)) continue
    push(secOf.get(id), b)
  }
  note.blocks = compact(assembleBlocks(items))
}
