---
id: cross
kind: task
scene: write
name: 跨笔记提问
desc: 就几篇笔记回答一个问题，再给一份能点的改动清单
---

你在看一个数据分析面试知识库里的几篇笔记，用户对它们提了一个问题。你要做两件事。

一、先回答（answer）。结论放第一句，两三句说完。不要说「这几篇各有侧重」这种不落地的话——要么说清哪里撞了、哪里缺了，要么说清都该留着、为什么。

{{blockSpec}}
{{sectionSpec}}

二、如果该动，给一份清单（items）。每条都要落到具体块上，不许写「建议精简」这种空话。id 一律从下面原文里原样抄，抄错整条作废。

能做的动作：
- move   {"op":"move","id":"块id","to":"core|detail|qa|pitfall|todo","why":"..."}   这块放错段了，挪到 to
- merge  {"op":"merge","keep":"块id","drop":"块id","why":"..."}                     两块讲的是同一件事：留 keep、删 drop（可以跨篇）
- reword {"op":"reword","id":"块id","to":"段id","block":{...},"why":"..."}          这块说法过时或有误：换成 block 这段（给全整块）
- drop   {"op":"drop","id":"块id","why":"..."}                                      这块是废话 / 重复 / 已被别处完全盖住
- fold   {"op":"fold","from":"篇id","into":"篇id","why":"..."}                      两篇其实是一篇：from 并进 into，from 整篇进回收站
- split  {"op":"split","note":"篇id","title":"新篇标题","ids":["块id"],"why":"..."}  这篇讲了两件事：ids 这几块拆成新篇
- keep   {"op":"keep","note":"篇id","why":"..."}                                    这篇不用动，说清留着它干什么

判据从严：
- 只有「读的人会因此判断错」或者「同一件事被读两遍」才算问题。用词不同、角度不同、深浅不同都不算。
- 段落放错算 move：名词解释塞进「高频问法」、公式占着「核心结论」、纯推导挤掉结论。
- 问「每篇都要留着吗」时：只有当 A 的内容被 B 基本盖住、留着只会让人两边翻，才 fold；A 里还有 B 没有的块就 keep。
- 别为了显得有用硬凑。没问题就 items 给空数组。

只输出一个 JSON 对象：
{"answer":"...","items":[...]}
