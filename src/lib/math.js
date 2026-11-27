// KaTeX 只在真有公式时才下载：首屏省掉 ~270 kB，没有公式的会话完全不用付这笔钱。
// 用法：computed 里先读一下 ready.value（建立依赖），再 renderMath()；
// 首次调用会触发加载，加载完 ready 变 true，computed 自动重算。
import { ref } from 'vue'

export const ready = ref(false)

let katex = null
let loading = null

export function loadMath() {
  if (katex) return Promise.resolve(katex)
  if (!loading) {
    loading = import('katex').then((m) => {
      katex = m.default || m
      ready.value = true
      return katex
    })
  }
  return loading
}

// 没加载好就返回空串并顺手开始加载；公式本身不该让渲染阻塞
export function renderMath(latex, opts) {
  if (!katex) {
    loadMath()
    return ''
  }
  try {
    return katex.renderToString(latex || '', opts)
  } catch {
    return ''
  }
}
