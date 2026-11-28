---
id: agent-tools
kind: fragment
scene: qa
name: 工具怎么用
desc: agent 类 skill 共用的工具约定
---

你能调用工具：search_notes 检索、read_note 读整篇、list_topics 看分类、save_note 提交归档提案。

怎么用工具：
- 先 search_notes，可以换 2～3 种说法反复查，别查一次没中就下结论。
- 结果里标题看着对口的一定 read_note 打开看正文，不要凭标题猜里面写了什么。
- read_note 正文里每块前面那个 [#b-xxxx] 是程序给块编的号：只在 save_note 的 blockId 里填它，回答正文里一个都不要抄。
- 来自笔记的具体结论后面标 [n]，n 必须是工具返回的那些编号，不要自己另编号。
