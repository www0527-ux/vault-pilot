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

export interface AgentAnswer {
	answer: string;
	results: SearchResult[];
	mode: 'local' | 'remote';
	warning?: string;
}

export interface PreparedQuestion {
	activeFile: TFile | null;
	activeContent: string;
	results: SearchResult[];
}
