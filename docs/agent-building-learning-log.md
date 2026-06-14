# Agent Building Learning Log

This document records engineering lessons from building VaultPilot as a learning project. The goal is not only to fix the current bug, but to name the hard parts and compare them with mature patterns used in production RAG and agent systems.

## 2026-06-05 - RAG Query Rewrite and Source Quality

### Problem Observed

A short mixed-language identity query like `duzhe + Chinese "who is"` failed more often than a longer query. In escaped form:

```text
duzhe\u662f\u8c01
```

The remote rewrite broadened or guessed variants such as:

```text
duzhe identity introduction
duzhe who is
reader who is
du zhe who is
guessed Chinese-name forms
```

This created two problems:

- The model guessed aliases that the user did not provide.
- Broad generic terms diluted retrieval precision.

A longer user query worked better because it gave the rewriter more context and still preserved the exact entity:

```text
look up the person duzhe; related materials are also acceptable
```

### Root Causes

- Query rewrite was optimized for recall, but short entity queries need precision first.
- The remote rewriter was allowed to translate or infer aliases too aggressively.
- The original user question was appended after rewritten queries, so it could be pushed out by the query limit.
- Mixed Chinese/Latin text needed token-boundary handling so keyword retrieval can still see `duzhe`.
- Source display previously treated `maxResults` as a fixed count, which made weak tail candidates visible.

### Current Fixes

- Made rewrite prompts entity-preserving:
  - Keep original proper nouns, usernames, romanized names, acronyms, and file-like tokens exactly as written.
  - For short identity queries such as `x + who is`, include the bare entity token.
  - Do not guess Chinese characters for unknown romanized names.
  - Avoid generic terms unless combined with the exact entity.
- Put the original question first when normalizing remote rewrite output.
- Split Latin/Chinese token boundaries before tokenization.
- Prune weak retrieval results after multi-query merge and rerank, so source count is a maximum rather than a fixed quota.

### Mature Patterns To Study

#### Query Transformation

Mature RAG systems often treat query rewriting as a controlled query transformation stage rather than a free-form prompt. Useful patterns:

- Multi-query expansion: generate several precise retrieval queries.
- Step-back queries: retrieve broader conceptual background only when the user asks conceptual questions.
- HyDE: generate a hypothetical answer/document, then retrieve against that representation.
- Entity-preserving rewrite: for personal vaults, exact names, filenames, tags, paths, and aliases should outrank semantic paraphrases.

For VaultPilot, the next version should classify the query first:

```text
entity lookup -> exact entity preservation
concept question -> semantic expansion
project/status question -> path, heading, and recent-note expansion
```

Prompt design for decomposition:

```text
1. Classify the query type internally.
2. Preserve exact entities before any semantic rewrite.
3. If the question is complex, split it into atomic retrieval needs.
4. Make every subquery self-contained by repeating the entity/concept names.
5. Order queries from precise to broad.
6. Return only structured JSON used by the retrieval pipeline.
```

Good decomposition targets:

- one entity lookup
- one side of a comparison
- one relation between two entities
- one cause or consequence
- one requested attribute, such as status, timeline, decision, risk, or evidence

Bad decomposition patterns:

- pronoun-based queries like `why did it fail`
- generic queries like `related materials`
- guessed aliases not supplied by the user
- answer-like subquestions that require synthesis instead of retrieval

#### Hybrid Retrieval

Current VaultPilot uses weighted hybrid retrieval:

```text
BM25 0.3 + embedding 0.7
```

This is a good learning baseline. Mature systems often add:

- Separate candidate pools for lexical, dense, and title/path search.
- RRF or weighted fusion for first-pass recall.
- Metadata filters for folder, tag, date, note type, or active project.
- Minimum relevance gates before answer generation.

The main lesson: top-k is only a candidate budget. It should not become the number of citations shown to the user.

#### Reranking

VaultPilot currently uses a deterministic local rerank based on title, path, heading, and multi-query hits.

Mature options to study:

- Cross-encoder rerankers.
- Cohere/Jina/bge-style reranking APIs or local rerank models.
- LLM-based relevance grading for the top 10-20 candidates.
- Contextual compression: keep only the relevant passage inside each candidate.

For VaultPilot, reranking should probably be the next major quality milestone after query rewrite stabilizes.

#### Evaluation

Prompt tuning by visual inspection is not enough. Each RAG bug should become an eval case.

Minimum local eval set:

```text
question
expected note path(s)
forbidden note path(s)
query type
notes
```

Metrics to track:

- Recall@k: did the expected note appear?
- Precision@shown: were displayed sources actually relevant?
- MRR: how high was the first relevant result?
- Answer groundedness: did the answer cite only retrieved evidence?
- No-source behavior: did the assistant correctly refuse vault-grounded claims?

The `duzhe` short-identity case should become a regression test before more prompt tuning.

### Mature Tools Worth Comparing

- LangChain / LangGraph: useful for explicit RAG and agent workflows with retrieval, relevance grading, query rewriting, and controllable graph steps.
- LlamaIndex: strong reference point for query transformations, retrieval pipelines, reranking, and response synthesis.
- Haystack: useful reference for production-style retrieval pipelines with retrievers and rerankers.
- Ragas / DeepEval-style evaluation: useful for measuring retrieval quality, faithfulness, and answer relevance, but should be paired with a small hand-labeled golden set for this vault.

### Next Experiments

1. Add a small `vaultpilot-rag-regression-set.jsonl` with real failed questions.
2. Log the rewritten queries and retrieved paths for each eval case.
3. Compare:
   - original query only
   - remote multi-query rewrite
   - entity-preserving rewrite
   - rewrite + rerank
4. Add a relevance gate before remote answer generation:
   - if no source survives pruning, answer with "no reliable vault evidence found."
5. Consider a second-pass relevance grader for top candidates before showing sources.

### Learning Takeaway

Building an agent is less about making one model call smarter and more about building a visible control system:

```text
intent classification
-> query transformation
-> retrieval
-> reranking
-> evidence gating
-> grounded answer
-> trace and evaluation
```

Each failed question should be converted into:

- a named failure mode
- a regression case
- a comparison against mature RAG patterns
- a small implementation experiment
