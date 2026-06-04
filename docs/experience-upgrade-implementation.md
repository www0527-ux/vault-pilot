# VaultPilot Experience Upgrade Implementation

This document records the assistant experience and retrieval upgrades implemented after the initial RAG indexing work.

## Implemented Changes

### Response Process UI

- Replaced the prominent evidence banner with a compact process summary inside each assistant message.
- Added live status updates while a question is being processed:
  - `Understanding question`
  - `Preparing answer`
  - `Writing answer`
- Added a default-collapsed process panel that shows:
  - Original question.
  - Retrieval queries.
  - Rewrite method.
  - Retrieval mode.
  - Reference count.
  - Confidence summary.
  - Timing details.
  - Model process text when the provider streams or returns reasoning content.

The UI intentionally avoids labels such as "chain of thought". It shows user-facing process information and provider-supplied reasoning text only inside the collapsed process panel.

### Streaming Behavior

- Restored streaming output for remote answers.
- Split remote streaming into two channels:
  - Answer deltas render in the main response body.
  - Process/reasoning deltas render inside the collapsed process area.
- Added a small answer gate so common process-style opening paragraphs are moved into the process panel instead of appearing as the final answer.
- Final remote responses are still cleaned and re-rendered as Markdown after the stream completes.

### Query Rewrite

- Added a `QueryRewrite` structure with:
  - `rewrittenQuery`
  - `rewrittenQueries`
  - `keywords`
  - `method`
  - `confidence`
- Added a remote query rewrite step for configured chat providers.
- Added a local rule-based fallback for local-only mode or rewrite failures.
- Changed remote rewrite prompting from a single query to multi-query generation.
- The rewrite prompt now asks for:
  - Original entity preservation.
  - Title/path variants.
  - Semantic variants.
  - Possible pinyin, romanized, and hyphenated forms for Chinese names.

No hardcoded entity alias table is used.

### Multi-Query Retrieval

- Added `IndexManager.searchMany()`.
- Each rewritten query is retrieved independently through the existing hybrid retrieval path.
- Results are merged by chunk id or file path.
- Repeated hits across multiple queries increase ranking confidence.

### Lightweight Rerank

Added a deterministic rerank pass after multi-query retrieval. It boosts candidates that match:

- Note title.
- File path.
- Heading path.
- Multiple rewritten queries.

This is intended to help short entity queries where embeddings alone may not bridge a Chinese name to an English or romanized title.

### Evidence Boundary

- Local mode is labeled as candidate retrieval rather than synthesized answering.
- Weak retrieval candidates are labeled as weak candidates in the process summary.
- Remote answers still cite and show retrieved sources, but confidence wording is conservative when retrieval scores are thin.

### Encoding Cleanup

- Replaced corrupted UI strings with stable ASCII UI copy.
- Kept answer content multilingual, but avoided non-ASCII static UI labels in source files to prevent repeat encoding corruption.

## Design Decisions

- No plugin memory was added.
- Recent sources are not stored or used for follow-up retrieval.
- Entity aliasing should be handled by query rewrite and general retrieval/rerank behavior, not per-entity hardcoding.
- The current rerank is deterministic and local. A future model-based reranker can be added after evaluation.

## Current Retrieval Flow

```text
User question
-> query rewrite
-> multiple retrieval queries
-> BM25 + embedding hybrid retrieval per query
-> merge candidates
-> title/path/heading-aware rerank
-> answer with sources
-> process summary and source list
```

## Follow-Up Work

- Add retrieval evaluation for multi-query rewrite and rerank.
- Add a generic pinyin conversion strategy or library if Chinese-name retrieval remains weak.
- Consider adaptive second-pass rewrite when top results are weak.
- Consider an optional model reranker for the top 10-20 candidates.
- Improve source jumping to exact line numbers when Obsidian APIs allow it cleanly.
