import { TFile } from 'obsidian';

export interface NoteChunk {
	id: string;
	file: TFile;
	title: string;
	headingPath: string[];
	content: string;
	contextText: string;
	startLine: number;
	endLine: number;
}

export interface SearchResult {
	file: TFile;
	score: number;
	excerpt: string;
	matches: string[];
	chunk?: NoteChunk;
}

export interface FolderInspectionOptions {
	path: string;
	maxFiles?: number;
	maxHeadingsPerFile?: number;
	maxExcerptsPerFile?: number;
}

export interface FolderInspection {
	path: string;
	fileCount: number;
	chunkCount: number;
	returnedFileCount: number;
	truncated: boolean;
	topSubfolders: Array<{
		path: string;
		fileCount: number;
	}>;
	topHeadings: Array<{
		heading: string;
		count: number;
	}>;
	files: Array<{
		path: string;
		basename: string;
		chunkCount: number;
		headings: string[];
		excerpts: string[];
	}>;
}

export interface FolderClassificationOptions {
	path: string;
	category: string;
	keywords?: string[];
	maxFiles?: number;
	includeUncertain?: boolean;
}

export interface FolderClassification {
	path: string;
	category: string;
	method: 'lexical';
	totalFiles: number;
	matchedFileCount: number;
	uncertainFileCount: number;
	returnedMatchedFileCount: number;
	returnedUncertainFileCount: number;
	truncated: boolean;
	matchedFiles: ClassifiedFolderFile[];
	uncertainFiles: ClassifiedFolderFile[];
}

export interface ClassifiedFolderFile {
	path: string;
	basename: string;
	score: number;
	evidence: string[];
}

export type QueryRewriteMethod = 'rule-based' | 'remote' | 'agent-tool';

export interface QueryRewrite {
	originalQuestion: string;
	rewrittenQuery: string;
	rewrittenQueries: string[];
	keywords: string[];
	method: QueryRewriteMethod;
	confidence: 'low' | 'medium' | 'high';
	warning?: string;
}

export interface TraceSource {
	title: string;
	path: string;
	score: number;
	excerpt: string;
	section?: string;
	lines?: string;
	matches: string[];
}

export interface ResponseTrace {
	originalQuestion: string;
	rewrittenQuery: string;
	rewriteMethod: QueryRewriteMethod;
	retrievalMode: string;
	sourceCount: number;
	sources: TraceSource[];
	toolCalls?: TraceToolCall[];
	confidenceSummary: string;
	modelProcess: string[];
	timings: {
		understandingMs: number;
		retrievalMs: number;
		totalMs: number;
	};
	warnings: string[];
}

export interface TraceToolCall {
	name: string;
	ok: boolean;
	input: string;
	summary: string;
	durationMs: number;
	error?: string;
}

export interface AgentAnswer {
	answer: string;
	results: SearchResult[];
	mode: 'local' | 'remote';
	trace: ResponseTrace;
	warning?: string;
}

export type AgentStreamEvent =
	| { type: 'status'; label: string }
	| { type: 'step_start'; step: number; label: string }
	| { type: 'step_finish'; step: number; label: string; durationMs: number }
	| { type: 'step_error'; step: number; label: string; error: string; durationMs: number }
	| { type: 'answer'; delta: string }
	| { type: 'process'; delta: string }
	| { type: 'tool_start'; name: string; inputSummary: string }
	| { type: 'tool_result'; name: string; ok: boolean; summary: string; durationMs: number; error?: string };

export interface PreparedQuestion {
	activeFile: TFile | null;
	activeContent: string;
	results: SearchResult[];
	trace: ResponseTrace;
}
