// 识图：图片压到够用的尺寸再交给视觉模型抄成可编辑内容

import { loadAI, isAiReady, DEFAULT_VISION, chat, pickJson } from './client.js'
import { str } from './schema.js'

/* ---------- 识图：截图 → LaTeX / 文字 ---------- */
// 图片先缩到长边 1600 再转 base64：请求体不至于几十 MB，慢网也能发出去
export async function imageToDataUrl(source, { maxSide = 1600, quality = 0.85 } = {}) {
  let blob = source
  if (typeof source === 'string') {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`图片读不到（HTTP ${res.status}）`)
    blob = await res.blob()
  }
  if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('这不是图片')

  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((ok, no) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => no(new Error('图片解码失败'))
      i.src = url
    })
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    cv.getContext('2d').drawImage(img, 0, 0, w, h)
    return cv.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const OCR_SYSTEM = `你帮人把图里的内容抄成能编辑的东西，图多半是统计 / 机器学习公式的截图。
只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏：
- 图里是公式：{"kind":"formula","latex":"...","text":"一句话说这是什么"}
- 图里是文字 / 表格 / 代码：{"kind":"text","text":"按原样抄，保留换行"}

latex 用单反斜杠，不要用 $ 包裹，不要 \\begin{equation} 这类环境。
看不清的地方宁可写 \\text{?}，也不许猜一个看起来合理的式子。`

export async function ocrImage({ src, cfg } = {}) {
  const c = cfg || loadAI()
  const v = c.vision || DEFAULT_VISION
  if (!isAiReady(v))
    throw new Error('还没配视觉模型，去「设置 → 视觉模型」加一个能看图的（智谱 glm-4v-flash 免费）')

  const dataUrl = await imageToDataUrl(src)
  const text = await chat(
    [
      { role: 'system', content: OCR_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '把这张图转成 JSON。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { cfg: v, temperature: 0.1, maxTokens: 1200 },
  )
  const data = pickJson(text)
  return {
    kind: data.kind === 'text' ? 'text' : 'formula',
    latex: str(data.latex),
    text: str(data.text),
  }
}
