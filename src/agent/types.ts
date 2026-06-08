import { SearchResult } from '../rag/types';
import { RetrievalService } from '../services/retrieval-service';
import { VaultNoteService } from '../services/vault-note-service';

export type ToolRisk = 'read' | 'write' | 'dangerous';

export interface ToolInputSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: ToolInputSchema;
	};
}

export interface ToolContext {
	vaultNotes: VaultNoteService;
	retrieval: RetrievalService;
	maxResults: number;
}

export interface AgentTool<TInput, TOutput> {
	name: string;
	description: string;
	risk: ToolRisk;
	schema: ToolInputSchema;
	execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface ToolExecutionResult {
	call: ToolCall;
	output: unknown;
	ok: boolean;
	error?: string;
	durationMs: number;
	results?: SearchResult[];
	searchQueries?: string[];
}

export interface AgentRunRequest {
	question: string;
	maxSteps?: number;
	onStatus?: (label: string) => void;
	onAnswerDelta?: (delta: string) => void;
}

export interface AgentRunResult {
	answer: string;
	results: SearchResult[];
	toolResults: ToolExecutionResult[];
	durationMs: number;
	warnings: string[];
}
