import { SearchResult } from '../rag/types';
import { ChatClientOptions } from '../llm/chat';
import { ChatMessage, completeChatStream, completeChatWithTools } from '../llm/chat';
import { ToolContext, AgentRunRequest, AgentRunResult, ToolExecutionResult } from './types';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';

const DEFAULT_MAX_STEPS = 4;

export class AgentRunner {
	constructor(
		private chatOptions: ChatClientOptions,
		private registry: ToolRegistry,
		private executor: ToolExecutor,
		private context: ToolContext,
	) {}

	async run(request: AgentRunRequest): Promise<AgentRunResult> {
		const startedAt = Date.now();
		const messages: ChatMessage[] = [
			{ role: 'system', content: buildSystemPrompt() },
			{ role: 'user', content: request.question },
		];
		const toolResults: ToolExecutionResult[] = [];
		const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;

		for (let step = 0; step < maxSteps; step += 1) {
			request.onStatus?.(step === 0 ? 'Choosing tools' : 'Reviewing tool results');
			const response = await completeChatWithTools(this.chatOptions, messages, this.registry.listDefinitions());
			if (response.toolCalls.length === 0) {
				return {
					answer: response.answer || 'I could not produce an answer from the available tool results.',
					results: dedupeResults(toolResults.flatMap((result) => result.results ?? [])),
					toolResults,
					durationMs: Date.now() - startedAt,
					warnings: [],
				};
			}

			messages.push({
				role: 'assistant',
				content: response.answer || null,
				tool_calls: response.rawToolCalls,
			});

			for (let index = 0; index < response.toolCalls.length; index += 1) {
				const call = response.toolCalls[index];
				const rawCall = response.rawToolCalls[index];
				if (!call || !rawCall) {
					continue;
				}
				request.onStatus?.(`Running ${call.name}`);
				const result = await this.executor.execute(call, this.context);
				toolResults.push(result);
				messages.push({
					role: 'tool',
					tool_call_id: rawCall.id,
					content: JSON.stringify(toModelToolOutput(result)),
				});
			}

			request.onStatus?.('Writing answer');
			const final = await completeChatStream(this.chatOptions, messages, (event) => {
				if (event.type === 'answer') {
					request.onAnswerDelta?.(event.delta);
				}
			});
			return {
				answer: final.answer || 'I could not produce an answer from the available tool results.',
				results: dedupeResults(toolResults.flatMap((result) => result.results ?? [])),
				toolResults,
				durationMs: Date.now() - startedAt,
				warnings: [],
			};
		}

		return {
			answer: 'The agent reached its tool-call step limit before producing a final answer.',
			results: dedupeResults(toolResults.flatMap((result) => result.results ?? [])),
			toolResults,
			durationMs: Date.now() - startedAt,
			warnings: ['Tool-call step limit reached'],
		};
	}
}

function buildSystemPrompt(): string {
	return [
		'You are VaultPilot, an Obsidian knowledge agent.',
		'Use tools when the answer depends on the user vault, the current note, note contents, or related links.',
		'When calling search_notes, provide retrieval-ready query parameters yourself.',
		'Preserve exact entities from the user request. For complex questions, provide several focused queries.',
		'Do not make a separate plan visible to the user. Do not expose hidden reasoning.',
		'After tool results arrive, answer using only the tool-provided vault evidence. Cite note paths in square brackets.',
		'If the tool results are insufficient, say what is missing and suggest what to search next.',
		'Do not claim a rewritten query or search plan is vault evidence.',
	].join('\n');
}

function toModelToolOutput(result: ToolExecutionResult): unknown {
	const output = stripRawResults(result.output);
	return {
		ok: result.ok,
		tool: result.call.name,
		durationMs: result.durationMs,
		error: result.error,
		output,
	};
}

function stripRawResults(output: unknown): unknown {
	if (!isRecord(output)) {
		return output;
	}
	const rest = { ...output };
	delete rest.rawResults;
	return rest;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const deduped: SearchResult[] = [];
	for (const result of results) {
		const key = result.chunk?.id ?? result.file.path;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(result);
	}
	return deduped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
