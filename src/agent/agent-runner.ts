import { SearchResult } from '../rag/types';
import { ChatClientOptions } from '../llm/chat';
import { ChatMessage, completeChatStream, completeChatText, completeChatWithTools } from '../llm/chat';
import { ToolContext, AgentRunRequest, AgentRunResult, ToolExecutionResult } from './types';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';

const TOOL_STEP_LIMIT_WARNING = 'Tool-call step limit reached';

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
			{ role: 'system', content: buildSystemPrompt(request.memoryContext, request.conversationContext) },
			{ role: 'user', content: request.question },
		];
		const toolResults: ToolExecutionResult[] = [];
		const process: string[] = [];
		const maxSteps = request.maxSteps;
		await this.emitInitialProcess(request, process);

		for (let step = 0; maxSteps === undefined || step < maxSteps; step += 1) {
			const stepStartedAt = Date.now();
			const stepNumber = step + 1;
			const stepLabel = step === 0 ? 'Choosing tools' : 'Reviewing tool results';
			this.emitStatus(request, stepLabel);
			request.onEvent?.({ type: 'step_start', step: stepNumber, label: stepLabel });

			let response;
			try {
				response = await completeChatWithTools(this.chatOptions, messages, this.registry.listDefinitions());
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				request.onEvent?.({
					type: 'step_error',
					step: stepNumber,
					label: stepLabel,
					error: message,
					durationMs: Date.now() - stepStartedAt,
				});
				throw error;
			}
			if (response.toolCalls.length === 0) {
				request.onEvent?.({
					type: 'step_finish',
					step: stepNumber,
					label: 'Final answer ready',
					durationMs: Date.now() - stepStartedAt,
				});
				this.emitStatus(request, 'Writing answer');
				const streamed = await this.streamFinalAnswer(request, messages);
				return {
					answer: streamed || response.answer || 'I could not produce an answer from the available tool results.',
					results: dedupeResults(toolResults.flatMap((result) => result.results ?? [])),
					toolResults,
					process,
					durationMs: Date.now() - startedAt,
					warnings: [],
				};
			}

			if (response.answer?.trim()) {
				const note = response.answer.trim();
				process.push(note);
				request.onEvent?.({ type: 'process', delta: `\n\n${note}` });
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
				this.emitStatus(request, `Running ${call.name}`);
				request.onEvent?.({
					type: 'tool_start',
					name: call.name,
					inputSummary: summarizeToolInput(call.name, call.input),
				});
				const result = await this.executor.execute(call, this.context);
				toolResults.push(result);
				request.onEvent?.({
					type: 'tool_result',
					name: call.name,
					ok: result.ok,
					summary: summarizeToolResult(result),
					durationMs: result.durationMs,
					error: result.error,
				});
				messages.push({
					role: 'tool',
					tool_call_id: rawCall.id,
					content: JSON.stringify(toModelToolOutput(result)),
				});
			}

			request.onEvent?.({
				type: 'step_finish',
				step: stepNumber,
				label: `Completed ${response.toolCalls.length} tool call${response.toolCalls.length === 1 ? '' : 's'}`,
				durationMs: Date.now() - stepStartedAt,
			});
		}

		request.onEvent?.({
			type: 'step_error',
			step: maxSteps ?? toolResults.length,
			label: 'Stopped after tool limit',
			error: TOOL_STEP_LIMIT_WARNING,
			durationMs: Date.now() - startedAt,
		});
		return {
			answer: buildStepLimitAnswer(toolResults),
			results: dedupeResults(toolResults.flatMap((result) => result.results ?? [])),
			toolResults,
			process,
			durationMs: Date.now() - startedAt,
			warnings: [TOOL_STEP_LIMIT_WARNING],
		};
	}

	private emitStatus(request: AgentRunRequest, label: string): void {
		request.onStatus?.(label);
		request.onEvent?.({ type: 'status', label });
	}

	private async emitInitialProcess(request: AgentRunRequest, process: string[]): Promise<void> {
		try {
			const note = await completeChatText(this.chatOptions, [
				{ role: 'system', content: buildProgressPrompt() },
				{ role: 'user', content: request.question },
			]);
			const cleaned = cleanProgressNote(note);
			if (!cleaned) {
				return;
			}
			process.push(cleaned);
			request.onEvent?.({ type: 'process', delta: cleaned });
		} catch (error) {
			console.debug('VaultPilot progress note generation failed.', error);
		}
	}

	private async streamFinalAnswer(request: AgentRunRequest, messages: ChatMessage[]): Promise<string> {
		try {
			const response = await completeChatStream(
				this.chatOptions,
				[
					...messages,
					{ role: 'system', content: buildFinalAnswerPrompt() },
				],
				(event) => {
					if (event.type === 'answer') {
						request.onAnswerDelta?.(event.delta);
						request.onEvent?.({ type: 'answer', delta: event.delta });
						return;
					}
					request.onEvent?.({ type: 'process', delta: event.delta });
				},
			);
			return response.answer.trim();
		} catch (error) {
			console.debug('VaultPilot final answer streaming failed.', error);
			return '';
		}
	}
}

function buildSystemPrompt(memoryContext?: string, conversationContext?: string): string {
	return [
		'You are VaultPilot, an Obsidian knowledge agent.',
		formatMemoryContext(memoryContext),
		formatConversationContext(conversationContext),
		'Use tools when the answer depends on the user vault, the current note, note contents, or related links.',
		'Tool paths must be vault-relative paths. If the user gives an absolute filesystem path, convert it to the path relative to the vault before calling tools.',
		'When calling search_notes, provide retrieval-ready query parameters yourself.',
		'Preserve exact entities from the user request. For complex questions, provide several focused queries.',
		'If helpful before using tools, write one brief user-facing progress sentence in assistant content. Do not expose hidden reasoning.',
		'After tool results arrive, answer using only the tool-provided vault evidence. Cite note paths in square brackets.',
		'If the tool results are insufficient, say what is missing and suggest what to search next.',
		'Do not keep calling tools just to exhaustively inspect every candidate. Once the evidence is enough to answer, stop using tools and write the answer.',
		'For broad project or documentation-summary questions, summarize the main themes from representative search results and only read specific notes when excerpts are not enough.',
		'For folder-level questions, call inspect_folder first. Do not use repeated read_note calls to scan a folder.',
		'For category-count questions inside a folder, call classify_folder_files. Do not estimate semantic category counts from inspect_folder alone.',
		'Do not claim a rewritten query or search plan is vault evidence.',
	].join('\n');
}

function formatConversationContext(conversationContext?: string): string {
	const cleaned = conversationContext?.trim();
	if (!cleaned) {
		return 'No prior conversation context is available.';
	}
	return [
		'Recent conversation context follows. Use it to resolve pronouns, follow-up questions, and user intent. It is not vault evidence.',
		cleaned,
	].join('\n\n');
}

function formatMemoryContext(memoryContext?: string): string {
	const cleaned = memoryContext?.trim();
	if (!cleaned) {
		return 'No saved VaultPilot memory is available.';
	}
	return [
		'Saved VaultPilot memory follows. Treat it as user-editable preferences and project context, not vault evidence.',
		cleaned,
	].join('\n\n');
}

function buildProgressPrompt(): string {
	return [
		'You are VaultPilot, an Obsidian knowledge agent.',
		'Write exactly one short user-facing progress sentence before inspecting the vault.',
		'Describe what you are about to check, using the user language.',
		'Do not reveal hidden reasoning. Do not mention tools, JSON, implementation details, or citations.',
		'Do not answer the question.',
	].join('\n');
}

function buildFinalAnswerPrompt(): string {
	return [
		'Write the final answer now.',
		'Use only the vault evidence from the tool results already provided in this conversation.',
		'Cite note paths in square brackets when making claims from notes.',
		'If the evidence is insufficient, say what is missing and suggest what to search next.',
		'Do not call tools. Do not describe your process. Start directly with the answer.',
	].join('\n');
}

function cleanProgressNote(note: string): string {
	return note
		.replace(/^["'\s]+|["'\s]+$/gu, '')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, 180);
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

function summarizeToolInput(name: string, input: unknown): string {
	if (!isRecord(input)) {
		return '';
	}
	if (name === 'search_notes') {
		const query = typeof input.query === 'string' ? input.query.trim() : '';
		const queries = Array.isArray(input.queries)
			? input.queries.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
			: [];
		const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? `, limit ${input.limit}` : '';
		if (queries.length > 1) {
			return `${query || queries[0]} (${queries.length} queries${limit})`;
		}
		return query ? `${query}${limit}` : '';
	}
	if (name === 'read_note' || name === 'suggest_links') {
		return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : 'current note';
	}
	if (name === 'inspect_folder') {
		const path = typeof input.path === 'string' ? input.path.trim() : '';
		const maxFiles = typeof input.maxFiles === 'number' && Number.isFinite(input.maxFiles)
			? `, max ${input.maxFiles} files`
			: '';
		return `${path || 'vault root'}${maxFiles}`;
	}
	if (name === 'classify_folder_files') {
		const path = typeof input.path === 'string' ? input.path.trim() : '';
		const category = typeof input.category === 'string' ? input.category.trim() : '';
		return `${path || 'vault root'}: ${category}`;
	}
	return '';
}

function summarizeToolResult(result: ToolExecutionResult): string {
	if (!result.ok) {
		return result.error ?? 'Tool failed';
	}
	if (result.call.name === 'search_notes' && result.results) {
		const count = result.results.length;
		const topPaths = result.results.slice(0, 3).map((item) => item.file.path);
		return [`Found ${count} reference${count === 1 ? '' : 's'}`, ...topPaths].join('\n');
	}
	if (result.call.name === 'inspect_folder' && isRecord(result.output)) {
		const fileCount = typeof result.output.fileCount === 'number' ? result.output.fileCount : 0;
		const chunkCount = typeof result.output.chunkCount === 'number' ? result.output.chunkCount : 0;
		const returnedFileCount = typeof result.output.returnedFileCount === 'number' ? result.output.returnedFileCount : 0;
		return `Inspected ${fileCount} file${fileCount === 1 ? '' : 's'} and ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}; returned ${returnedFileCount} file summaries`;
	}
	if (result.call.name === 'classify_folder_files' && isRecord(result.output)) {
		const totalFiles = typeof result.output.totalFiles === 'number' ? result.output.totalFiles : 0;
		const matchedFileCount = typeof result.output.matchedFileCount === 'number' ? result.output.matchedFileCount : 0;
		const uncertainFileCount = typeof result.output.uncertainFileCount === 'number' ? result.output.uncertainFileCount : 0;
		return `Classified ${totalFiles} file${totalFiles === 1 ? '' : 's'}; matched ${matchedFileCount}, uncertain ${uncertainFileCount}`;
	}
	if (result.call.name === 'read_note' && isRecord(result.output)) {
		const path = typeof result.output.path === 'string' ? result.output.path : '';
		return path ? `Read ${path}` : 'Read note';
	}
	if (result.call.name === 'get_current_note' && isRecord(result.output)) {
		const path = typeof result.output.path === 'string' ? result.output.path : '';
		return path ? `Read current note: ${path}` : 'Checked current note';
	}
	if (result.call.name === 'suggest_links' && result.results) {
		const count = result.results.length;
		return `Suggested ${count} related note${count === 1 ? '' : 's'}`;
	}
	return 'Completed';
}

function buildStepLimitAnswer(toolResults: ToolExecutionResult[]): string {
	const results = dedupeResults(toolResults.flatMap((result) => result.results ?? [])).slice(0, 8);
	if (results.length === 0) {
		return [
			'The agent reached its tool-call step limit before producing a final answer.',
			'It did not gather enough usable vault evidence to summarize safely.',
		].join('\n\n');
	}

	const lines = results.map((result) => {
		const chunk = result.chunk;
		const location = chunk
			? `${result.file.path}, lines ${chunk.startLine}-${chunk.endLine}`
			: result.file.path;
		const excerpt = result.excerpt.trim() || '(empty excerpt)';
		return `- [${result.file.path}] ${location}: ${excerpt}`;
	});

	return [
		'The agent reached its tool-call step limit before producing a final answer.',
		'Here is the partial evidence gathered so far:',
		lines.join('\n'),
		'Try asking with a narrower project path or document name for a complete summary.',
	].join('\n\n');
}
