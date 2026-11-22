// 按域分文件的同步编排：一次编辑只推它所在域的那个文件
// 本地只管一堆 sha 和内容 hash，用来判断「远端变了没 / 本地改了没」
import { getFile, putFile, listDir } from './remote.js'
import {
  SCHEMA,
  splitSnapshot,
  fileKey,
  keyMatches,
  indexKey,
  fileBody,
  indexBody,
  hashStr,
  notesDirOf,
  notePathOf,
  noteFileOf,
  isLegacy,
} from './split.js'

const META_KEY = 'myknowledge.syncmeta'

const bodyHash = (o) => hashStr(JSON.stringify(o))

const emptyMeta = () => ({ sha: {}, key: {}, body: {} })

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (raw) {
      const m = JSON.parse(raw)
      return { sha: m.sha || {}, key: m.key || {}, body: m.body || {} }
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

const normIndex = (d) => ({
  schema: SCHEMA,
  domains: d.domains || [],
  topics: d.topics || [],
  updatedAt: d.updatedAt || 0,
})

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

  // 老版本：kb.json 里装着全部笔记，一次性迁移过去
  if (isLegacy(idx.data)) {
    const remoteNewer = (idx.data.updatedAt || 0) > (localSnap?.updatedAt || 0)
    const snap = remoteNewer
      ? {
          domains: idx.data.domains || [],
          topics: idx.data.topics || [],
          notes: idx.data.notes || [],
          updatedAt: idx.data.updatedAt || 0,
        }
      : localSnap
    writeMeta({ sha: { [cfg.path]: idx.sha }, key: {}, body: {} })
    return { snapshot: snap, changed: remoteNewer, legacy: true }
  }

  const local = splitSnapshot(localSnap || { domains: [], topics: [], notes: [] })
  const remoteIndex = normIndex(idx.data)
  const localIdxKey = indexKey(local.index)
  const first = !meta.key[cfg.path]
  let changed = false

  // ---- 索引（域 + 分类） ----
  let useIndex = local.index
  const idxDiffers = meta.sha[cfg.path] !== idx.sha
  if (idxDiffers) {
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

  // ---- 每个域的笔记 ----
  const remote = new Map((await listDir(cfg, notesDirOf(cfg))).map((f) => [f.name, f.sha]))
  const localNotes = new Map()
  for (const f of Object.values(local.files)) localNotes.set(f.domainId || '', f.notes || [])

  const byDomain = new Map()
  for (const d of useIndex.domains || []) byDomain.set(d.id, localNotes.get(d.id) || [])
  if (localNotes.has('')) byDomain.set('', localNotes.get(''))

  for (const domainId of [...byDomain.keys()]) {
    const name = noteFileOf(domainId)
    const path = notePathOf(cfg, domainId)
    const rsha = remote.get(name)
    if (!rsha) continue // 远端还没有这个文件，以本地为准
    if (meta.sha[path] === rsha) {
      const lf = local.files[name]
      if (!meta.key[path] && lf) meta.key[path] = fileKey(lf)
      continue
    }
    const lf = local.files[name]
    const localClean = ignoreLocal || !meta.key[path] || keyMatches(meta.key[path], lf)
    if (!localClean) continue // 本地也改了，本地赢

    const r = await getFile(cfg, path)
    if (!r || !Array.isArray(r.data?.notes)) continue
    const rf = { schema: SCHEMA, domainId, notes: r.data.notes }
    byDomain.set(domainId, rf.notes)
    meta.sha[path] = r.sha
    meta.key[path] = fileKey(rf)
    meta.body[path] = bodyHash(fileBody(rf))
    changed = true
  }

  writeMeta(meta)
  if (!changed) return null

  const notes = []
  for (const arr of byDomain.values()) notes.push(...arr)
  return {
    snapshot: {
      domains: useIndex.domains || [],
      topics: useIndex.topics || [],
      notes,
      updatedAt: useIndex.updatedAt || Date.now(),
    },
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
    const name = path.split('/').pop()
    const list = await listDir(cfg, dir)
    const sha = list.find((f) => f.name === name)?.sha
    return await putFile(cfg, path, data, sha, message)
  }
}

/**
 * 只推内容真的变了的文件。返回 { pushed }，pushed 为空说明无事可做。
 */
export async function pushDirty(cfg, localSnap, { force = false } = {}) {
  const meta = readMeta()
  const { index, files } = splitSnapshot(localSnap)
  const pushed = []

  const ik = indexKey(index)
  const ib = bodyHash(indexBody(index))
  if (force || (meta.key[cfg.path] !== ik && meta.body[cfg.path] !== ib)) {
    const sha = await putSafe(cfg, cfg.path, '', indexBody(index), 'kb: 目录与分类')
    meta.sha[cfg.path] = sha
    meta.key[cfg.path] = ik
    meta.body[cfg.path] = ib
    pushed.push(cfg.path)
  }

  const need = []
  for (const f of Object.values(files)) {
    const path = notePathOf(cfg, f.domainId)
    const fb = bodyHash(fileBody(f))
    // 内容真的变了才提交：updatedAt / version 这类每次都变的字段不该在云端留空 commit
    if (force || (!keyMatches(meta.key[path], f) && meta.body[path] !== fb)) need.push({ path, f, fb })
  }

  if (need.length) {
    const dir = notesDirOf(cfg)
    const remote = new Map((await listDir(cfg, dir)).map((x) => [x.name, x.sha]))
    for (const { path, f, fb } of need) {
      const name = noteFileOf(f.domainId)
      // 远端已有同名的就带上它的 sha，没有就走新建
      if (remote.has(name)) meta.sha[path] = remote.get(name)
      const sha = await putSafe(cfg, path, dir, fileBody(f), `kb: ${name}`)
      meta.sha[path] = sha
      meta.key[path] = fileKey(f)
      meta.body[path] = fb
      pushed.push(path)
    }
  }

  writeMeta(meta)
  return { pushed }
}
