// 用 GitHub 仓库当数据库：一个私有仓库里的单个 kb.json
// 纯前端调用 Contents API，token 只存在本机浏览器 localStorage

const CFG_KEY = 'myknowledge.remote'

export const DEFAULT_REMOTE = {
  owner: 'cccyyy527',
  repo: 'myknowledge-data',
  branch: 'main',
  path: 'kb.json',
  token: '',
}

export function loadRemote() {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) return { ...DEFAULT_REMOTE, ...JSON.parse(raw) }
  } catch (e) {
    console.warn('同步配置读取失败', e)
  }
  return { ...DEFAULT_REMOTE }
}

export function saveRemote(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg))
}

export function clearRemote() {
  localStorage.removeItem(CFG_KEY)
}

export const isConfigured = (c) => Boolean(c && c.owner && c.repo && c.token)

const apiBase = (c) => `https://api.github.com/repos/${c.owner}/${c.repo}/contents`
const fileUrl = (c, path) => `${apiBase(c)}/${encodeURI(String(path).replace(/^\/+/, ''))}`

const headers = (c) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${c.token}`,
  'X-GitHub-Api-Version': '2022-11-28',
})

// Contents API 用 base64，中文必须走 TextEncoder 才不坏
function b64encode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function errText(res) {
  try {
    const j = await res.json()
    return `${res.status} ${j.message || res.statusText}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}

// 读一个文件；不存在返回 null（首次上传 / 目录还没建）
export async function getFile(cfg, path) {
  const res = await fetch(`${fileUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  if (Array.isArray(json)) throw new Error(`${path} 是目录，不是文件`)
  return { data: JSON.parse(b64decode(json.content)), sha: json.sha }
}

export async function putFile(cfg, path, data, sha, message) {
  const body = {
    message: message || `kb: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    content: b64encode(JSON.stringify(data, null, 2)),
    branch: cfg.branch,
  }
  if (sha) body.sha = sha
  const res = await fetch(fileUrl(cfg, path), {
    method: 'PUT',
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  return json.content.sha
}

// 删一个文件（笔记被彻底删掉 / 老布局的域文件迁走后清理）
export async function deleteFile(cfg, path, sha, message) {
  const res = await fetch(fileUrl(cfg, path), {
    method: 'DELETE',
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || `kb: 删除 ${String(path).split('/').pop()}`,
      sha,
      branch: cfg.branch,
    }),
  })
  if (!res.ok && res.status !== 404) throw new Error(await errText(res))
  return true
}

// 列目录拿各文件 sha：一次请求就知道哪些变了，不用逐个下载
export async function listDir(cfg, dir) {
  const res = await fetch(`${fileUrl(cfg, dir)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  if (!Array.isArray(json)) return []
  return json.filter((f) => f.type === 'file').map((f) => ({ name: f.name, sha: f.sha }))
}
