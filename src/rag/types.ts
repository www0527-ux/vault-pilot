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
