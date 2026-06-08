import { AgentTool, ToolContext } from './types';

interface SearchNotesInput {
	query?: string;
	queries?: string[];
	limit?: number;
}

interface ReadNoteInput {
	path?: string;
}

export function createDefaultTools(): AgentTool<unknown, unknown>[] {
	return [
		getCurrentNoteTool,
		readNoteTool,
		searchNotesTool,
		suggestLinksTool,
	];
}

const getCurrentNoteTool: AgentTool<unknown, unknown> = {
	name: 'get_current_note',
	description: 'Read the active Markdown note, including its path, content, headings, and wiki links.',
	risk: 'read',
	schema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_input: unknown, context: ToolContext) {
		const note = await context.vaultNotes.getCurrentNote();
		return note ?? { note: null, message: 'No active Markdown note.' };
	},
};

const readNoteTool: AgentTool<ReadNoteInput, unknown> = {
	name: 'read_note',
	description: 'Read a Markdown note by vault-relative path. Use this after search_notes when an excerpt is not enough.',
	risk: 'read',
	schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Vault-relative Markdown path, such as notes/example.md.' },
		},
		required: ['path'],
		additionalProperties: false,
	},
	async execute(input: ReadNoteInput, context: ToolContext) {
		if (!input.path?.trim()) {
			throw new Error('read_note requires path.');
		}
		return context.vaultNotes.readNote(input.path.trim());
	},
};

const searchNotesTool: AgentTool<SearchNotesInput, unknown> = {
	name: 'search_notes',
	description: [
		'Search the Obsidian vault with retrieval-ready queries.',
		'The model should provide exact entities and decompose complex questions into focused queries.',
	].join(' '),
	risk: 'read',
	schema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Primary retrieval query preserving the user intent and exact entities.' },
			queries: {
				type: 'array',
				description: 'Optional focused retrieval queries for multi-part or ambiguous questions.',
				items: { type: 'string' },
			},
			limit: { type: 'number', description: 'Maximum number of results to return.' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	async execute(input: SearchNotesInput, context: ToolContext) {
		const query = input.query?.trim();
		if (!query) {
			throw new Error('search_notes requires query.');
		}
		const limit = clampLimit(input.limit, context.maxResults);
		const queries = normalizeQueries(query, input.queries);
		const rawResults = await context.retrieval.searchNotes({ query, queries, limit });
		return {
			query,
			queries,
			results: rawResults.map((result) => ({
				path: result.file.path,
				title: result.file.basename,
				score: result.score,
				excerpt: result.excerpt,
				section: result.chunk?.headingPath.join(' > ') || result.chunk?.title,
				lines: result.chunk ? `${result.chunk.startLine}-${result.chunk.endLine}` : undefined,
				matches: result.matches,
			})),
			rawResults,
		};
	},
};

const suggestLinksTool: AgentTool<ReadNoteInput, unknown> = {
	name: 'suggest_links',
	description: 'Suggest related notes for the active note or a specified Markdown note path.',
	risk: 'read',
	schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Optional vault-relative Markdown path. Defaults to the current note.' },
		},
		additionalProperties: false,
	},
	async execute(input: ReadNoteInput, context: ToolContext) {
		const note = input.path?.trim()
			? await context.vaultNotes.readNote(input.path.trim())
			: await context.vaultNotes.getCurrentNote();
		if (!note) {
			throw new Error('No active Markdown note for link suggestions.');
		}
		const file = context.vaultNotes.getActiveMarkdownFile();
		if (!file || file.path !== note.path) {
			throw new Error('suggest_links currently supports the active Markdown note only.');
		}
		const rawResults = await context.retrieval.suggestLinks(file);
		return {
			path: note.path,
			results: rawResults.map((result) => ({
				path: result.file.path,
				title: result.file.basename,
				score: result.score,
				excerpt: result.excerpt,
				matches: result.matches,
			})),
			rawResults,
		};
	},
};

function normalizeQueries(query: string, queries: string[] | undefined): string[] {
	return Array.from(new Set([query, ...(queries ?? [])].map((candidate) => candidate.trim()).filter(Boolean)));
}

function clampLimit(limit: number | undefined, fallback: number): number {
	if (typeof limit !== 'number' || !Number.isFinite(limit)) {
		return fallback;
	}
	return Math.max(1, Math.min(Math.round(limit), 12));
}
