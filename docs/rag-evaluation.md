# VaultPilot RAG 检索评估

## 评估目标

本实验只评估检索阶段，不调用聊天模型生成最终答案。目标是回答三个工程问题：

1. BM25 和 embedding 在多跳问答中的差异是什么？
2. 简单加权混合是否优于单路检索？
3. 默认混合权重应该选择 `0.5 / 0.5` 还是 `0.3 / 0.7`？

## 数据集

- 来源：[HotpotQA dev distractor split](https://hotpotqa.github.io/)
- 固定随机种子：`20260604`
- 问题数量：200
- 候选文档：1979 篇 Markdown 文档
- 任务特点：每个问题通常需要多个 gold evidence page，且候选集中包含干扰文档
- 检索单位：Markdown chunk
- Top-k：5

每个问题使用官方 supporting facts 对应的页面作为 qrels。除了普通 Recall@k，本实验重点关注 `All-gold Recall@5`，用于衡量前五条结果是否包含回答多跳问题所需的全部证据页面。

## 指标

| 指标 | 含义 |
| --- | --- |
| Top-1 hit | 第一条结果是否包含任意 gold evidence page |
| Recall@3 | 前三条是否包含任意 gold evidence page |
| Recall@5 | 前五条是否包含任意 gold evidence page |
| All-gold Recall@5 | 前五条是否包含该问题的全部 gold evidence page |
| MRR | 第一个正确 evidence page 排名倒数的平均值 |

## 实验组

| 组别 | 策略 | 状态 |
| --- | --- | --- |
| A | BM25 only | 已完成 |
| B | Embedding only | 已完成 |
| C | BM25 0.5 + Embedding 0.5 | 已完成 |
| D | BM25 0.3 + Embedding 0.7 | 已完成 |
| E | Reciprocal Rank Fusion | 已完成 |
| F | RRF + rerank | 未完成 |

## 实验结果

| 检索策略 | Top-1 hit | Recall@3 | Recall@5 | All-gold Recall@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25 only | 85.50% | 97.00% | 99.50% | 71.00% | 0.9110 |
| Embedding only | 92.00% | 99.50% | 99.50% | **88.50%** | **0.9550** |
| Hybrid 0.5 / 0.5 | 91.50% | 97.50% | **100.00%** | 84.50% | 0.9468 |
| Hybrid 0.3 / 0.7 | **92.00%** | **99.50%** | **100.00%** | 87.00% | 0.9538 |
| Hybrid RRF | 91.00% | 99.00% | 99.50% | 87.00% | 0.9493 |

每组均评估相同的 200 个问题。

## 结果分析

BM25 的 Recall@5 达到 99.50%，说明关键词检索通常能召回至少一个正确页面；但 All-gold Recall@5 只有 71.00%，说明它在多跳问题中容易只命中其中一个证据页面。

Embedding-only 的 Top-1 hit、All-gold Recall@5 和 MRR 均为最高，说明 HotpotQA 自然语言问题与证据页面之间更依赖语义匹配。

Hybrid 0.3 / 0.7 相比 0.5 / 0.5：

- Recall@3：`97.50% → 99.50%`
- All-gold Recall@5：`84.50% → 87.00%`
- MRR：`0.9468 → 0.9538`
- Recall@5：均为 `100.00%`

因此产品默认权重选择 BM25 0.3 / embedding 0.7。这个选择保留了关键词检索对实体和标题匹配的帮助，同时让语义检索在自然语言问答场景中占主导。

RRF 避免直接比较 BM25 与 cosine similarity 的原始分数，但在当前子集上没有超过 embedding-only 或 0.3 / 0.7 加权融合。因此，下一阶段更值得验证 rerank 或 query-aware 权重，而不是继续只调整融合公式。

## 性能记录

| 场景 | 文档 / chunk / embedding | 耗时 |
| --- | --- | ---: |
| 首次全量索引 | 2066 / 2822 / 2822 | 722.8s |
| 文档缓存命中，首次 query embedding | 1979 / 1979 / 1979 | 18s |
| 文档和 query embedding 均命中缓存 | 五组 × 200 queries | 约 4.8s |

首次构建的主要成本来自本地 embedding 生成。稳定复用文档 embedding 和 query embedding 后，检索消融实验可以在数秒内完成。

## 复现步骤

项目需要位于 Obsidian vault 的 `.obsidian/plugins/vaultpilot` 目录。

```bash
npm install
npm run prepare:hotpotqa
```

启动 Ollama 并准备 embedding 模型：

```bash
ollama pull nomic-embed-text
```

在 Obsidian 中启用 VaultPilot，运行 `Rebuild index`，等待 HotpotQA 文档 embedding 构建完成，然后执行：

```bash
npm run eval:hotpotqa
```

脚本会在 vault 根目录下生成 `_rag_dataset/hotpotqa-dev-mini` 和 `_rag_eval/hotpotqa-dev-mini`。这些数据集、逐 query 结果与向量缓存属于本地实验产物，不提交到插件源码仓库。

## 评估边界

- 当前结果只代表 retrieval quality，不代表最终答案正确率或忠实度。
- 尚未正式评估引用准确率、无来源拒答和生成答案 groundedness。
- RRF 已完成，RRF + rerank 尚未完成。
- 200-query 子集适合工程迭代，不等价于完整 HotpotQA benchmark 成绩。
