# VaultPilot Experience Upgrade Plan

This document captures the next product and engineering direction for VaultPilot so development can continue on another machine without losing context.

## Current State

VaultPilot is an Obsidian knowledge assistant with:

- Markdown note indexing and heading-aware chunking.
- BM25 keyword retrieval.
- Local Ollama embedding retrieval.
- Hybrid retrieval with BM25 weight `0.3` and embedding weight `0.7`.
- Disk index cache with reusable embeddings.
- `_rag_eval/` excluded from indexing to avoid experiment notes invalidating the cache.
- HotpotQA retrieval evaluation scripts for BM25, embedding, weighted hybrid, and RRF.

Related learning notes:

- `docs/agent-building-learning-log.md` records RAG and agent-building failure modes, mature solution patterns, and regression-test ideas.

The latest HotpotQA dev mini retrieval-only evaluation used:

- 200 queries.
- 1979 HotpotQA documents.
- 1979 cached document embeddings.
- 200 cached query embeddings.

Result summary:

| Mode | Top-1 | Recall@3 | Recall@5 | All-gold Recall@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25 only | 85.50% | 97.00% | 99.50% | 71.00% | 0.9110 |
| Embedding only | 92.00% | 99.50% | 99.50% | 88.50% | 0.9550 |
| Hybrid 0.5 / 0.5 | 91.50% | 97.50% | 100.00% | 84.50% | 0.9468 |
| Hybrid 0.3 / 0.7 | 92.00% | 99.50% | 100.00% | 87.00% | 0.9538 |
| Hybrid RRF | 91.00% | 99.00% | 99.50% | 87.00% | 0.9493 |

The current product decision is to keep weighted hybrid retrieval and use `0.3 / 0.7` as the default. RRF remains useful as an experimental result but should not replace the production fusion strategy yet.

## Immediate Product Goal

Move VaultPilot from a basic RAG chat panel toward a more mature assistant experience.

The next UI flow should feel like:

```text
Understand intent -> Search vault -> Answer -> Show sources
```

The assistant should make the process visible without exposing raw chain-of-thought. Show a user-facing trace, not hidden model reasoning.

## Feature 1: Collapsible Trace Panel

Add a collapsible panel to each assistant response.

Suggested label:

```text
Understanding and search plan
```

Avoid labels such as:

```text
Chain of thought
Full reasoning
```

The panel should include:

- Original user question.
- Rewritten retrieval query.
- Retrieval mode, for example `Hybrid retrieval - BM25 0.3 / Embedding 0.7`.
- Number of sources found.
- Source titles and snippets.
- Retrieval confidence summary.
- Timing information if available.

Default behavior:

- During processing, show compact live statuses.
- After answer generation, collapse the trace by default.
- Let users expand it for transparency.

## Feature 2: Intent Understanding and Query Rewrite

Before retrieval, add a query understanding step.

UI state:

```text
Understanding your question...
```

The rewrite should produce a retrieval-oriented query, not a final answer.

Example:

```text
Original:
Why can we know at least two objects fall into the same class without listing all objects?

Retrieval understanding:
Pigeonhole principle / drawer principle / at least two objects / same category / existence proof
```

Important distinction:

- The rewrite is model interpretation.
- Retrieved sources are vault evidence.
- Do not present rewritten concepts as if they were found in the vault.

Implementation approach:

- If remote chat provider is configured, use a small query rewrite prompt.
- If local-only mode or rewrite fails, use a rule-based fallback that returns the original question plus extracted keywords.
- Use the rewritten query for retrieval.
- Keep the original user question for final answer generation.

## Feature 3: Retrieval Status UI

After query understanding, show:

```text
Searching your vault...
```

Use a lightweight animated status, such as:

- A subtle pulsing dot.
- A compact step list.
- Source skeleton chips.

Suggested status sequence:

```text
Understanding question
Searching notes
Ranking sources
Preparing answer
```

Do not overuse technical terms in the main UI. Technical details can live inside the trace panel.

## Feature 4: Honest Evidence Boundary

The answer header should always distinguish vault-grounded answers from model-prior answers.

When reliable sources exist:

```text
Based on your vault - referenced 3 sources
```

When no reliable sources exist:

```text
No reliable vault evidence found - answer uses model knowledge
```

Do not say:

```text
Search for: pigeonhole principle / drawer principle
```

unless the UI clearly marks it as model interpretation rather than vault evidence.

Low-confidence behavior:

- If the user asks a general knowledge question, answer with a clear model-knowledge disclaimer.
- If the user asks about their personal vault and no evidence is found, say that VaultPilot cannot answer from the vault.
- Never fabricate citations.

## Feature 5: Source Shortcuts

After the answer, show a source section if sources exist.

Suggested UI:

```text
Sources

1. 06-Pigeonhole Principle
   Basic form - lines 7-12
   If n + 1 objects are placed into n boxes...

2. 05-Counting Principles
   Classification idea - lines 14-20
   ...
```

Each source item should support:

- Open note.
- Jump to line if feasible.
- Show excerpt.
- Optionally show retrieval type in the trace panel, not in the main answer.

If no sources exist:

```text
Sources
No reliable vault sources were found.
```

## Future Memory Feature

Memory should be planned but not implemented yet.

Risks and design questions:

- User preference memory.
- Session memory.
- Long-term vault-grounded memory.
- Privacy controls.
- Clear/delete memory commands.

Do not add memory until the trace and query rewrite experience is stable.

## Future Agent Features

After the assistant experience is stable, consider:

- Tool calling.
- Obsidian command execution.
- MCP integration.
- File creation and editing with diff previews.
- Task planning inside the vault.

These should reuse the same trace panel:

```text
Understand -> Retrieve -> Tool call -> Answer
```

## Release Preparation Notes

Before submitting to the Obsidian community plugin catalog:

- Remove test-only copy.
- Ensure no API keys are tracked.
- Keep `data.json`, `main.js`, `.datasets`, and generated caches ignored.
- Document external service usage in `README.md`.
- Explain that vault content may be sent to configured chat/embedding endpoints.
- State that telemetry is not collected.
- Keep local-only operation available.
- Make settings labels and error states clear.

## Suggested Next Implementation Order

1. Add a response trace data structure.
2. Add collapsible trace UI.
3. Add intent understanding and query rewrite.
4. Route retrieval through the rewritten query.
5. Add answer evidence headers.
6. Improve source shortcut UI.
7. Add low-confidence evidence boundary behavior.
8. Update README and release notes.
