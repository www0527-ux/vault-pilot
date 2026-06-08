import { SearchResult } from '../rag/types';
import { ToolContext, ToolCall, ToolExecutionResult } from './types';
import { ToolRegistry } from './tool-registry';

export class ToolExecutor {
	constructor(private registry: ToolRegistry) {}

	async execute(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
		const startedAt = Date.now();
		const tool = this.registry.get(call.name);
		if (!tool) {
			return {
				call,
				output: { error: `Unknown tool: ${call.name}` },
				ok: false,
				error: `Unknown tool: ${call.name}`,
				durationMs: Date.now() - startedAt,
			};
		}

		try {
			const output = await tool.execute(call.input, context);
			return {
				call,
				output,
				ok: true,
				durationMs: Date.now() - startedAt,
				results: extractSearchResults(output),
				searchQueries: extractSearchQueries(output),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				call,
				output: { error: message },
				ok: false,
				error: message,
				durationMs: Date.now() - startedAt,
			};
		}
	}
}

function extractSearchResults(output: unknown) {
	if (!isRecord(output) || !Array.isArray(output.rawResults)) {
		return undefined;
	}
	return output.rawResults.filter(isSearchResult);
}

function extractSearchQueries(output: unknown): string[] | undefined {
	if (!isRecord(output) || !Array.isArray(output.queries)) {
		return undefined;
	}
	return output.queries.filter((query): query is string => typeof query === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSearchResult(value: unknown): value is SearchResult {
	return isRecord(value) && isRecord(value.file) && typeof value.file.path === 'string';
}
