# myknowledge

数据分析面试私人知识库。原型阶段：块结构笔记 + 10 域 × 三级分类，纯前端。

## 跑起来

```bash
npm install
npm run dev      # http://localhost:5174
```

## 现在有什么

- 10 个知识域，分类可三级（如 `机器学习模型 / 线性家族 / 逻辑回归`），左侧折叠树 + 域页／分组页逐级下钻
- 侧边栏可编辑：点「✎ 编辑」后可直接改名、加分类、加子分类、删域删分类（删分组不丢笔记，笔记上移）
- 笔记不是 Markdown，是块：`概念卡 / 公式卡 / 对比卡 / 问答卡 / 坑卡 / 步骤卡 / 提示 / 待补`
- 归位规则：**域（领域）→ 一级分类（话题）→ 二级分类（细分）→ 笔记（一个知识点）**，到叶子为止；
  叶子下面再细分用**标签**切片（分类页按标签过滤），不靠继续加深层级
- 笔记内部四段骨架固定：`核心结论 → 推导 / 细节 → 高频问法 → 我踩过的坑`，
  编辑时每个分区尾部有自己的 `+` 按钮，新块只会落进你按的那一段
- 三种阅读模式：阅读 / 编辑 / 速查（只看卡片）
- 全局聚合页：术语表 / 公式库 / 问答库 / 坑清单，由笔记里的块自动汇总
- 示例笔记：`AB 实验 / 方差缩减 / CUPED 方差缩减`

## 数据存哪

原型阶段：浏览器 `localStorage`，键名 `myknowledge.v3`（整篇笔记的 `blocks` 数组直接序列化进去），
改完 700ms 自动保存，刷新不丢、`dist/` 与 `node_modules/` 不入库。

局限：清站点数据即丢、手机和电脑不同步、没有历史版本、没有账号。

## 云同步（可选）

顶栏 ☁ 按钮里填 GitHub 私有仓库 + fine-grained token，即可多端同步：

- 数据落在 `owner/repo/branch/path` 指定的单个 `kb.json`（默认 `myknowledge-data` / `main` / `kb.json`）
- token 只要有该仓库的 **Contents: Read and write**，只存本机 localStorage，不经过任何第三方
- 启动时若云端 `updatedAt` 更新则覆盖本地；编辑后 2s 防抖上传，每次上传是一个 commit（等于版本历史）
- 手机和电脑同时改，后保存的覆盖前者

## AI 助手（可选）

顶栏 ✨ 打开，两处用法：

- **收进来**：贴一段零散笔记 → AI 挑分类、切成知识块、按「核心结论 / 推导 / 高频问法 / 我踩过的坑 / 待补」归位 → 先看预览，确认后才写入新笔记
- **单块改写**：编辑模式下每个块右上角 ✨ → 润色 / 扩写 / 拆成知识块 / 造高频问法 / 造踩坑卡 → 先看预览，点「采用」才替换

配置：面板里「设置」填 Base URL、模型、API Key。

- 默认 DeepSeek：`https://api.deepseek.com` + `deepseek-chat`
- 任何 OpenAI 兼容接口都能用（把 Base URL 换成对应地址、模型名换成对应模型）
- Key 只存本机 `localStorage`，直连服务商，不经过任何第三方；换设备要重填
- 拿 Key：<https://platform.deepseek.com/api_keys>

## 部署

推 `main` 触发 `.github/workflows/deploy.yml`：构建后把 `dist/` 强制推到 `gh-pages` 分支
（用 `peaceiris/actions-gh-pages@v4`，不需要 Pages API 权限）。

首次启用只需一次（GitHub 现在不给 `GITHUB_TOKEN` 建站点的权限，必须手动点）：

1. 仓库 **Settings → Pages**
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `gh-pages`，目录选 `/ (root)`，Save
4. 等 1 分钟，访问 `https://cccyyy527.github.io/myknowledge/`

注意：

- Free 账号下 Pages **只支持公开仓库**，所以本仓库是 public；笔记正文不在这个仓库里
- 站点是公开可访问的静态页面，但**数据要靠浏览器里的 token 才能拉取**，别人打开只会看到空库
- 之后每次推 `main`，`gh-pages` 会被覆盖更新，Pages 自动重新发布

## 结构

```
src/
  lib/seed.js      # 10 域、三级分类、示例笔记
  lib/store.js     # 内存状态 + localStorage 持久化 + 统计/搜索/聚合 + 目录增删改
  lib/remote.js    # GitHub Contents API：拉取 / 上传 kb.json
  lib/ai.js        # AI：提示词 / 块归一化 / 自动落位 / 单块改写
  components/BlockView.vue   # 块 → 知识卡渲染
  components/BlockEdit.vue   # 块 → 编辑控件（公式带实时预览）
  components/SyncDialog.vue  # 云同步配置面板
  components/AiPanel.vue     # AI 面板（收进来 / 设置）
  components/AiBlockDialog.vue # AI 单块改写弹窗
  pages/           # 首页 / 域 / 分类（可含下级）/ 笔记 / 聚合 / 搜索
```
