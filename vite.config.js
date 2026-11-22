import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub Pages 是 https://<user>.github.io/<repo>/，资源要挂在 /<repo>/ 下；
// 本地 dev / preview 仍用根路径，所以只在 CI 里切 base
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/myknowledge/' : '/',
  plugins: [vue()],
  server: { host: true, port: 5174 },
  preview: { host: true, port: 4174 },
})
