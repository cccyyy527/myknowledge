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

const url = (c) =>
  `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${encodeURI(c.path)}`

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

// 远端还没有 kb.json 时返回 null（首次上传的情况）
export async function pull(cfg) {
  const res = await fetch(`${url(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  return { data: JSON.parse(b64decode(json.content)), sha: json.sha }
}

export async function push(cfg, data, sha) {
  const body = {
    message: `kb: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    content: b64encode(JSON.stringify(data, null, 2)),
    branch: cfg.branch,
  }
  if (sha) body.sha = sha
  const res = await fetch(url(cfg), {
    method: 'PUT',
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errText(res))
  const json = await res.json()
  return json.content.sha
}
