# VaultPilot

VaultPilot is an Obsidian knowledge agent plugin for vault Q&A, source inspection, and link suggestions.

It is designed as a learning-friendly agent project: the first version works without a backend or vector database, while still leaving room for RAG, embeddings, Dataview, Omnisearch, Ollama, and OpenAI-compatible model providers.

## What It Does

- Opens a right sidebar agent view inside Obsidian.
- Searches Markdown notes in the current vault.
- Answers questions with matching source notes.
- Explains the current note.
- Suggests related `[[wikilinks]]` for the active note.
- Supports lightweight Chinese and English search tokens.
- Can run in local search mode.
- Can call an OpenAI-compatible chat completions endpoint when configured.

## Why This Project Exists

This project avoids rebuilding all of Obsidian. It reuses:

- Obsidian's plugin API for vault access, commands, settings, and sidebar views.
- Markdown files as the knowledge base.
- Obsidian's native note links and file model.

The agent layer focuses on the useful missing piece: turning vault operations into explainable tools.

## Install for Local Development

1. Clone or copy this folder into your Obsidian vault:

   ```text
   YourVault/.obsidian/plugins/vaultpilot
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the plugin:

   ```bash
   npm run build
   ```

4. In Obsidian, enable community plugins and turn on `VaultPilot`.

5. Open the command palette and run:

   ```text
   Open VaultPilot agent
   ```

## Settings

VaultPilot has two answer modes:

- `Local search`: no API key required. It searches notes and produces a source-based local answer.
- `OpenAI-compatible`: sends retrieved note excerpts to a configured chat completions endpoint.

The default endpoint is:

```text
https://api.openai.com/v1/chat/completions
```

You can also use compatible providers such as OpenRouter, LM Studio, or a local gateway if they expose the same request format.

## Current Agent Tools

The first version has four core tools:

- `get_current_note`: reads the active Markdown note.
- `search_notes`: scores Markdown files by title, path, headings, and content.
- `read_note`: represented by source opening and retrieved excerpts.
- `suggest_links`: finds related notes that are not already linked.

## Roadmap

Good next milestones:

- Add one-click insertion for suggested links.
- Add Dataview integration for tags, tasks, and frontmatter queries.
- Add Omnisearch integration for stronger keyword and BM25 search.
- Add embeddings and a vector index for semantic RAG.
- Add an agent trace panel that shows each tool call.
- Add a note cleanup workflow for tags, aliases, summaries, and frontmatter.
- Add a learning mode that generates review questions from selected notes.

## Development

Build once:

```bash
npm run build
```

Watch and rebuild:

```bash
npm run dev
```

Lint:

```bash
npm run lint
```

Generated files used by Obsidian:

- `main.js`
- `manifest.json`
- `styles.css`

## Project Status

VaultPilot is a working MVP. It is intentionally small enough for a beginner to understand, but structured so it can grow into a full Obsidian RAG agent.
