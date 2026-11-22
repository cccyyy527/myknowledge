// 初始骨架：9 个域 × 49 个子分类 + 1 篇示例笔记
// 只放一篇示例，其余子分类留空，用来演示「覆盖度」是怎么算出来的

export const DOMAINS = [
  { id: 'd1', slug: 'stats', name: '概率统计与假设检验', hint: '分布、检验、多重比较' },
  { id: 'd2', slug: 'sql', name: 'SQL 与数据仓库', hint: '窗口函数、留存口径、建模' },
  { id: 'd3', slug: 'metrics', name: '指标体系与异动归因', hint: 'OSM、拆解框架、归因树' },
  { id: 'd4', slug: 'ab', name: 'AB 实验与因果推断', hint: '分流、功效、CUPED、PSM/DID' },
  { id: 'd5', slug: 'ml', name: '机器学习模型', hint: '逻辑回归、树模型、评估' },
  { id: 'd6', slug: 'ua', name: '用户分析方法论', hint: '分层、漏斗、路径、RFM' },
  { id: 'd7', slug: 'eng', name: 'Python 与工程能力', hint: 'pandas、性能、数据管道' },
  { id: 'd8', slug: 'llm', name: 'LLM 与数分新范式', hint: '标签体系、RAG、评测' },
  { id: 'd9', slug: 'sense', name: '业务 Sense 与行为面', hint: '场景题、答题结构' },
]

export const TOPICS = [
  ['d1', 'probability', '概率与分布'],
  ['d1', 'sampling', '抽样与估计'],
  ['d1', 'hypothesis', '假设检验'],
  ['d1', 'multiple', '多重比较与稳健方法'],
  ['d1', 'regression', '回归与相关'],

  ['d2', 'sql-basic', 'SQL 基础'],
  ['d2', 'window', '窗口函数'],
  ['d2', 'modeling', '数仓建模'],
  ['d2', 'metric-calc', '指标口径计算'],
  ['d2', 'performance', '性能与执行'],
  ['d2', 'quality', '数据质量与治理'],

  ['d3', 'system', '指标体系设计'],
  ['d3', 'decompose', '指标拆解'],
  ['d3', 'attribution', '异动归因'],
  ['d3', 'anomaly', '数据异常排查'],
  ['d3', 'monitor', '监控与预警'],

  ['d4', 'design', '实验设计'],
  ['d4', 'power', '功效与样本量'],
  ['d4', 'traps', '实验陷阱'],
  ['d4', 'interpret', '结果解读'],
  ['d4', 'variance', '方差缩减'],
  ['d4', 'quasi', '准实验方法'],
  ['d4', 'noexp', '无法实验的场景'],

  ['d5', 'basics', '基础概念'],
  ['d5', 'models', '常用模型'],
  ['d5', 'eval', '模型评估'],
  ['d5', 'feature', '特征工程'],
  ['d5', 'landing', '业务落地'],
  ['d5', 'causal-ml', '因果机器学习'],

  ['d6', 'segment', '用户分层与分群'],
  ['d6', 'funnel', '路径与漏斗'],
  ['d6', 'retention', '留存与活跃'],
  ['d6', 'growth', '用户价值与增长'],
  ['d6', 'frameworks', '分析框架'],

  ['d7', 'pandas', 'Pandas 数据处理'],
  ['d7', 'perf', '性能与内存'],
  ['d7', 'pipeline', '数据管道'],
  ['d7', 'viz', '可视化与报表'],
  ['d7', 'collab', '协作与规范'],

  ['d8', 'llm-basics', 'LLM 基础'],
  ['d8', 'labeling', '标签体系与文本挖掘'],
  ['d8', 'rag', 'RAG 与知识库'],
  ['d8', 'eval-llm', '评测方法'],
  ['d8', 'ai-analysis', 'AI 辅助分析'],

  ['d9', 'scene', '场景题框架'],
  ['d9', 'business', '典型业务场景'],
  ['d9', 'selfintro', '自我介绍与项目讲述'],
  ['d9', 'askback', '反问与动机'],
  ['d9', 'soft', '软技能'],
].map(([domainId, slug, name]) => ({ id: `t-${slug}`, domainId, slug, name }))

let n = 0
const bid = () => `b${++n}`

// 示例笔记：CUPED —— 覆盖所有知识型块，用来演示「不是 Markdown」
export const DEMO_NOTE = {
  id: 'n-cuped',
  domainId: 'd4',
  topicId: 't-variance',
  title: 'CUPED 方差缩减',
  pinned: true,
  version: 3,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T12:40:00.000Z',
  blocks: [
    { id: bid(), type: 'heading', level: 2, text: '核心结论' },
    {
      id: bid(),
      type: 'paragraph',
      text: '用实验前就存在、且不受实验影响的协变量 X，把实验后指标 Y 里“本来就有的波动”扣掉。实验组和对照组之间的差异不变，噪声变小，等效于免费放大样本量。',
    },
    {
      id: bid(),
      type: 'callout',
      tone: 'tip',
      text: '面试常被追问：到底降了多少方差？答 1 − ρ²。ρ 是 X 与 Y 的相关系数，ρ=0.5 时方差降 25%，等效样本量放大约 1.33 倍。',
    },

    { id: bid(), type: 'heading', level: 2, text: '推导 / 细节' },
    {
      id: bid(),
      type: 'formula',
      latex: '\\theta=\\frac{\\operatorname{Cov}(X,Y)}{\\operatorname{Var}(X)},\\qquad Y^{\\text{cv}}=Y-\\theta\\,(X-\\bar X)',
      text: 'θ 是让 Var(Y − θX) 最小的系数，本质上就是 Y 对 X 做一次不含截距的回归，取残差作为新指标。X̄ 用全样本均值，保证期望不变。',
    },
    {
      id: bid(),
      type: 'formula',
      latex: '\\operatorname{Var}(Y^{\\text{cv}})=\\operatorname{Var}(Y)\\,(1-\\rho^2)',
      text: '所以“降方差”这件事完全取决于 X 与 Y 的相关性。X 选得不好，ρ 接近 0，做了等于白做。',
    },
    {
      id: bid(),
      type: 'definition',
      term: '无偏性',
      text: 'CUPED 不改变指标期望，只改变方差。因为 E[Y − θ(X − X̄)] = E[Y]，减掉的那一项期望为 0。',
      detail: '前提：X 必须在分流之前就已经确定，且不受处理影响。',
    },
    {
      id: bid(),
      type: 'steps',
      text: '落地四步',
      items: [
        '选 X：实验前 1~2 周的同一指标，或强相关的历史指标',
        '算 θ：在全样本上回归，注意不要按组分别算',
        '构造 Y_cv：对每个用户做变换',
        '照常比较均值差，置信区间用新方差',
      ],
    },
    {
      id: bid(),
      type: 'comparison',
      left: 'CUPED',
      right: '事后分层',
      rows: [
        { k: '依赖信息', a: '实验前的连续协变量', b: '实验前或用户属性类别' },
        { k: '降方差原理', a: '扣掉与 Y 相关的成分', b: '层内比较，消除层间差异' },
        { k: '实现成本', a: '低，一次回归', b: '中，分层多时每层样本不足' },
        { k: '风险', a: 'X 选错就无效', b: '层太细导致功效反而下降' },
      ],
    },

    { id: bid(), type: 'heading', level: 2, text: '高频问法' },
    {
      id: bid(),
      type: 'qa',
      question: 'CUPED 会引入偏差吗？',
      answer:
        '不会，只要 X 是实验前变量且不受处理影响。如果 X 被处理影响（比如用了实验期内的点击），就会把处理效应减掉一部分，得到有偏估计。',
    },
    {
      id: bid(),
      type: 'qa',
      question: 'X 该怎么选？',
      answer:
        '优先选与 Y 相关性高、且在分流前就能拿到的指标。常用：实验前同周期指标、用户历史活跃度、历史客单价。ρ 在 0.4~0.6 之间比较常见。',
    },

    { id: bid(), type: 'heading', level: 2, text: '我踩过的坑' },
    {
      id: bid(),
      type: 'pitfall',
      text: '按组分别算 θ，结果两组被扣掉的量不同，均值差直接失真。',
      cause: '想当然地“各组自己回归”。',
      avoid: 'θ 必须用全样本算一次，然后统一作用到两组。',
    },

    { id: bid(), type: 'heading', level: 2, text: '待补' },
    { id: bid(), type: 'todo', text: '补一个真实业务的降幅数据：X 选什么、ρ 多少、等效样本量提升多少。' },
  ],
}
