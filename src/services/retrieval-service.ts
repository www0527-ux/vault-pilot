import { TFile } from 'obsidian';
import { FolderInspection, FolderInspectionOptions, SearchResult } from '../rag/types';
import type VaultPilotPlugin from '../main';

export interface RetrievalSearchInput {
	query: string;
	queries?: string[];
	limit?: number;
}

export class RetrievalService {
	constructor(private plugin: VaultPilotPlugin) {}

	async searchNotes(input: RetrievalSearchInput): Promise<SearchResult[]> {
		const queries = normalizeQueries(input);
		const limit = input.limit ?? this.plugin.settings.maxResults;
		if (queries.length <= 1) {
			return this.plugin.searchNotes(queries[0] ?? input.query, limit);
		}
		return this.plugin.searchNotesMany(queries, limit);
	}

	async suggestLinks(file: TFile): Promise<SearchResult[]> {
		return this.plugin.suggestLinks(file);
	}

	async inspectFolder(options: FolderInspectionOptions): Promise<FolderInspection> {
		return this.plugin.inspectFolder(options);
	}
}

function normalizeQueries(input: RetrievalSearchInput): string[] {
	return Array.from(new Set([input.query, ...(input.queries ?? [])].map((query) => query.trim()).filter(Boolean)));
}
