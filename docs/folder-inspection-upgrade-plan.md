# Folder Inspection Upgrade Plan

This note records the design for folder-level analysis in VaultPilot.

## Problem

VaultPilot currently has two main retrieval tools:

- `search_notes`: query-oriented RAG over indexed chunks.
- `read_note`: full-note reading by exact path.

When the user asks broad questions such as "what is this project folder mainly about?", the agent may repeatedly call `read_note` to approximate folder scanning. That is inefficient for large folders and can lead to repeated reads of similar or identical files.

## Existing Asset

The RAG index already contains useful folder-analysis material:

- `file.path`
- `file.basename`
- `chunk.title`
- `chunk.headingPath`
- `chunk.content`
- `chunk.contextText`
- `startLine` and `endLine`

These are not generated summaries. They are structured chunk metadata and truncated source excerpts. However, they are enough to build a compact folder overview without re-reading every file.

## Market Pattern

Mature codebase and document assistants generally avoid letting the model read every file one by one. Common patterns include:

- Background indexing with reusable chunk embeddings.
- Repository or folder maps with paths, symbols, headings, and representative snippets.
- Hybrid retrieval: keyword search, semantic search, and structural filtering.
- Parent-child retrieval: retrieve small chunks, then merge or summarize at file/folder level.
- Summary trees or map-reduce summaries for broad summarization tasks.

VaultPilot should follow the same shape: index first, inspect the folder map, then read only a few representative files when exact detail is needed.

## Proposed Tool

Add an `inspect_folder` agent tool.

Input:

```ts
{
	path: string;
	maxFiles?: number;
	maxHeadingsPerFile?: number;
	maxExcerptsPerFile?: number;
}
```

Output:

```ts
{
	path: string;
	fileCount: number;
	chunkCount: number;
	topSubfolders: Array<{ path: string; fileCount: number }>;
	topHeadings: Array<{ heading: string; count: number }>;
	files: Array<{
		path: string;
		basename: string;
		chunkCount: number;
		headings: string[];
		excerpts: string[];
	}>;
	truncated: boolean;
}
```

## Agent Rules

For folder-level questions:

- Prefer `inspect_folder` first.
- Do not use repeated `read_note` calls to scan a folder.
- Use `read_note` only for a few representative files when exact details are needed.
- When the folder is large, summarize the structure and representative themes instead of claiming exhaustive coverage.

## Implementation Notes

- Implement the folder overview in `IndexManager` so it can reuse the existing chunk cache.
- Expose it through `RetrievalService`.
- Add `inspect_folder` to `src/agent/tools.ts`.
- Keep output compact and deterministic.
- Do not include raw full-file contents in tool output.

## Follow-Up

- Add per-run `read_note` de-duplication in `AgentRunner`.
- Consider a future persistent file/folder summary cache if folder summaries become expensive or commonly repeated.
- Consider Markdown-specific signals such as frontmatter tags, wiki links, and folder-level heading frequencies.
