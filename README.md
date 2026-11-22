# myknowledge

数据分析面试私人知识库。原型阶段：块结构笔记 + 9 域 × 49 子分类，纯前端。

## 跑起来

```bash
npm install
npm run dev      # http://localhost:5174
```

## 现在有什么

- 9 个知识域 / 49 个子分类（左侧可折叠树，域页做下钻）
- 笔记不是 Markdown，是块：`概念卡 / 公式卡 / 对比卡 / 问答卡 / 坑卡 / 步骤卡 / 提示 / 待补`
- 三种阅读模式：阅读 / 编辑 / 速查（只看卡片）
- 全局聚合页：术语表 / 公式库 / 问答库 / 坑清单，由笔记里的块自动汇总
- 示例笔记：`AB 实验与因果推断 / 方差缩减 / CUPED 方差缩减`

## 数据存哪

原型阶段：浏览器 `localStorage`，键名 `myknowledge.v1`（整篇笔记的 `blocks` 数组直接序列化进去），
改完 700ms 自动保存，刷新不丢、`dist/` 与 `node_modules/` 不入库。

局限：清站点数据即丢、手机和电脑不同步、没有历史版本、没有账号。

正式版（下一步）：Hono API + SQLite(本地) / D1(线上)，`notes.blocks_json` 存块，
派生表 `note_blocks` 驱动聚合页，FTS5(trigram) 做中文搜索，每日导出 JSON 备份。
届时前端只把 `store.js` 换成走 API 的适配层，页面与块渲染不用动。

## 结构

```
src/
  lib/seed.js      # 9 域、49 子分类、示例笔记
  lib/store.js     # 内存状态 + localStorage 持久化 + 统计/搜索/聚合
  components/BlockView.vue   # 块 → 知识卡渲染
  components/BlockEdit.vue   # 块 → 编辑控件（公式带实时预览）
  pages/           # 首页 / 域 / 子分类 / 笔记 / 聚合 / 搜索
```
