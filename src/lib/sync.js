// 一篇一个文件的同步编排：一次编辑只推那一篇
// 本地只管一堆 sha 和内容 hash，用来判断「远端变了没 / 本地改了没」
import { getFile, putFile, listDir, deleteFile } from './remote.js'
import {
  splitNotes,
  joinNotes,
  noteBody,
  noteBodyKey,
  noteKey,
  indexKey,
  indexBody,
  hashStr,
  notesDirOf,
  notePathOf,
  noteFileOf,
  isNoteFile,
  noteIdOfFile,
  isDomainFile,
  notesFromDomainFile,
  isLegacy,
} from './split.js'

const META_KEY = 'myknowledge.syncmeta'

const bodyHash = (o) => hashStr(JSON.stringify(o))

// meta.v：本地这份指纹的「格式版本」。3 = 一篇一个文件的布局，
// 升上来这一轮会把云端重写一遍（顺手把老布局的域文件迁走）
const META_V = 3

const emptyMeta = () => ({ v: 0, sha: {}, key: {}, body: {}, del: [] })

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (raw) {
      const m = JSON.parse(raw)
      return {
        v: m.v || 0,
        sha: m.sha || {},
        key: m.key || {},
        body: m.body || {},
        del: m.del || [],
      }
    }
  } catch (e) {
    console.warn('同步元数据读取失败', e)
  }
  return emptyMeta()
}

function writeMeta(m) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m))
  } catch (e) {
    console.warn('同步元数据写入失败', e)
  }
}

export function resetMeta() {
  try {
    localStorage.removeItem(META_KEY)
  } catch {}
}

// 这台机器同步过、但指纹还是「老布局」的格式 → 需要把云端重写一遍
export function needsRestamp() {
  const m = readMeta()
  return m.v !== META_V && Object.keys(m.sha).length > 0
}

const normIndex = (d) => ({
  schema: 3,
  domains: d.domains || [],
  topics: d.topics || [],
  updatedAt: d.updatedAt || 0,
})

// 云端文件里刻意不存 updatedAt（不然每次同步都在 diff 里刷一行时间戳），
// 拉回来时用本机同 id 笔记的时间补上；本机没有就拿 createdAt 兜底
const stamp = (n, localById) => ({
  ...n,
  updatedAt: localById.get(n.id)?.updatedAt || n.createdAt || new Date().toISOString(),
})
const withLocalTime = (notes, localById) => notes.map((n) => stamp(n, localById))

// 本地这一篇有没有改过：指纹对得上就是没改；从没记录过就当没改（远端赢）
const localCleanOf = (meta, path, note) =>
  !note || !meta.key[path] || meta.key[path] === noteKey(note)

/**
 * 拉取并就地合并。
 * 规则：远端变了、本地没改 → 接受远端；两边都改了 → 本地赢，等 push 时推上去。
 * 返回 { snapshot, changed, legacy }，没有需要应用的变化时返回 null。
 */
export async function pullAll(cfg, localSnap, { ignoreLocal = false } = {}) {
  if (ignoreLocal) writeMeta(emptyMeta())
  const meta = readMeta()
  const idx = await getFile(cfg, cfg.path)
  if (!idx) return null
  const localById = new Map((localSnap?.notes || []).map((n) => [n.id, n]))

  // 更老的单文件格式：kb.json 里装着全部笔记，接过来就行，push 时自然拆成一篇一个文件
  if (isLegacy(idx.data)) {
    const remoteNewer = (idx.data.updatedAt || 0) > (localSnap?.updatedAt || 0)
    const snap = remoteNewer
      ? {
          domains: idx.data.domains || [],
          topics: idx.data.topics || [],
          notes: withLocalTime(idx.data.notes || [], localById),
          updatedAt: idx.data.updatedAt || 0,
        }
      : localSnap
    writeMeta({ v: meta.v, sha: { [cfg.path]: idx.sha }, key: {}, body: {}, del: [] })
    return { snapshot: snap, changed: remoteNewer, legacy: true }
  }

  const local = splitNotes(localSnap || { domains: [], topics: [], notes: [] })
  const remoteIndex = normIndex(idx.data)
  const localIdxKey = indexKey(local.index)
  const first = !meta.key[cfg.path]
  let changed = false

  // ---- 索引（域 + 分类） ----
  let useIndex = local.index
  if (meta.sha[cfg.path] !== idx.sha) {
    const localClean = first
      ? (remoteIndex.updatedAt || 0) >= (localSnap?.updatedAt || 0)
      : meta.key[cfg.path] === localIdxKey
    if (localClean) {
      useIndex = remoteIndex
      meta.sha[cfg.path] = idx.sha
      meta.key[cfg.path] = indexKey(remoteIndex)
      meta.body[cfg.path] = bodyHash(indexBody(remoteIndex))
      changed = true
    }
  } else if (first) {
    meta.key[cfg.path] = localIdxKey
  }
  if (!meta.sha[cfg.path]) meta.sha[cfg.path] = idx.sha

  // ---- 笔记：一篇一个文件 ----
  const dir = notesDirOf(cfg)
  const list = await listDir(cfg, dir)
  const byId = new Map()
  for (const n of localSnap?.notes || []) byId.set(n.id, n)

  // 老布局（一个域一个文件）：全部读进来一次搬完，搬完把老文件排进待删
  const domainFiles = list.filter((f) => isDomainFile(f.name))
  if (domainFiles.length) {
    const joined = []
    for (const f of domainFiles) {
      const r = await getFile(cfg, `${dir}/${f.name}`)
      joined.push(...withLocalTime(notesFromDomainFile(r?.data), localById))
    }
    const remoteNewer = first || (remoteIndex.updatedAt || 0) > (localSnap?.updatedAt || 0)
    if (remoteNewer) {
      byId.clear()
      for (const n of joined) byId.set(n.id, n)
    }
    for (const f of domainFiles) {
      const p = `${dir}/${f.name}`
      if (!meta.del.includes(p)) meta.del.push(p)
      delete meta.sha[p]
      delete meta.key[p]
      delete meta.body[p]
    }
    changed = true // 老文件排上删除 + 新布局要写出去，让上层走一轮 push
  }

  for (const f of list) {
    if (!isNoteFile(f.name)) continue
    const id = noteIdOfFile(f.name)
    const path = notePathOf(cfg, id)
    const lf = byId.get(id)
    if (meta.sha[path] === f.sha) {
      if (!meta.key[path] && lf) meta.key[path] = noteKey(lf)
      continue
    }
    // 本地没这篇（别处新建）→ 收下；本地也改了 → 本地赢，等 push 推上去
    if (!(ignoreLocal || localCleanOf(meta, path, lf))) continue
    const r = await getFile(cfg, path)
    const rn = r?.data?.note
    if (!rn || !rn.id) continue
    const merged = stamp(rn, localById)
    byId.set(id, merged)
    meta.sha[path] = r.sha
    meta.key[path] = noteKey(merged)
    meta.body[path] = bodyHash(noteBody(merged))
    changed = true
  }

  // 这一轮写下去的都是当前格式的指纹，别让下次 push 误判成「需要重写一遍」
  meta.v = META_V
  writeMeta(meta)
  if (!changed) return null

  return {
    snapshot: joinNotes(useIndex, [...byId.values()], useIndex.updatedAt || Date.now()),
    changed: true,
    legacy: false,
  }
}

// 409 说明我们手里的 sha 已经被别人改了，重新列一次目录再写
async function putSafe(cfg, path, dir, data, message) {
  const meta = readMeta()
  try {
    return await putFile(cfg, path, data, meta.sha[path], message)
  } catch (e) {
    if (!/409|does not match|already exists/i.test(String(e.message || e))) throw e
    const name = String(path).split('/').pop()
    const list = await listDir(cfg, dir)
    const sha = list.find((f) => f.name === name)?.sha
    return await putFile(cfg, path, data, sha, message)
  }
}

/**
 * 只推内容真的变了的文件，顺手删掉本机已经没有的笔记文件。
 * 返回 { pushed, removed }，都为空说明无事可做。
 */
export async function pushDirty(cfg, localSnap, { force = false } = {}) {
  const meta = readMeta()
  const { index, files } = splitNotes(localSnap || { domains: [], topics: [], notes: [] })
  const pushed = []
  const removed = []
  // 指纹格式升级 / 换布局：这一轮把所有文件重写一遍（老的域文件在这一轮被删掉）
  const restamp = meta.v !== META_V

  const ik = indexKey(index)
  const ib = bodyHash(indexBody(index))
  if (force || restamp || (meta.key[cfg.path] !== ik && meta.body[cfg.path] !== ib)) {
    const sha = await putSafe(cfg, cfg.path, '', indexBody(index), 'kb: 目录与分类')
    meta.sha[cfg.path] = sha
    meta.key[cfg.path] = ik
    meta.body[cfg.path] = ib
    pushed.push(cfg.path)
  }

  const need = []
  for (const [id, body] of Object.entries(files)) {
    const path = notePathOf(cfg, id)
    const nk = noteBodyKey(body)
    const nb = bodyHash(body)
    // 内容真的变了才提交：updatedAt / version 这类每次都变的字段不该在云端留空 commit
    if (force || restamp || (meta.key[path] !== nk && meta.body[path] !== nb)) {
      need.push({ id, path, body, nk, nb })
    }
  }

  const delNow = [...meta.del]
  const dir = notesDirOf(cfg)
  // 本机删掉一篇时 need 是空的，得靠「记忆里有、本地没了」判断要不要去云端清孤儿文件
  const knownGone = Object.keys(meta.key).some((p) => {
    const name = p.split('/').pop()
    return p.startsWith(`${dir}/`) && isNoteFile(name) && !files[noteIdOfFile(name)]
  })
  if (need.length || delNow.length || force || knownGone) {
    const remote = await listDir(cfg, dir)
    const shaByName = new Map(remote.map((f) => [f.name, f.sha]))

    // 本机已经没有这篇（彻底删除）→ 云端文件也删掉。
    // 兜底：本地一篇都没有时不动远程，免得本地存储被清空就把云端全删了
    if (Object.keys(files).length) {
      for (const f of remote) {
        if (!isNoteFile(f.name)) continue
        if (files[noteIdOfFile(f.name)]) continue
        const p = `${dir}/${f.name}`
        if (!delNow.includes(p)) delNow.push(p)
      }
    }

    for (const { id, path, body, nk, nb } of need) {
      const name = noteFileOf(id)
      // 远端已有同名的就带上它的 sha，没有就走新建
      if (shaByName.has(name)) meta.sha[path] = shaByName.get(name)
      meta.sha[path] = await putSafe(cfg, path, dir, body, `kb: ${name}`)
      meta.key[path] = nk
      meta.body[path] = nb
      pushed.push(path)
    }

    for (const p of delNow) {
      const name = String(p).split('/').pop()
      const sha = meta.sha[p] || shaByName.get(name)
      // 拿不到 sha 说明远端本来就没有这个文件
      if (sha) {
        try {
          await deleteFile(cfg, p, sha, `kb: 删除 ${name}`)
          removed.push(p)
        } catch (e) {
          // 删不掉就留在 meta.del 里，下次同步再试
          if (!meta.del.includes(p)) meta.del.push(p)
          continue
        }
      }
      delete meta.sha[p]
      delete meta.key[p]
      delete meta.body[p]
      meta.del = meta.del.filter((x) => x !== p)
    }
  }

  meta.v = META_V
  writeMeta(meta)
  return { pushed, removed }
}
