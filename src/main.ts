/* eslint-disable obsidianmd/ui/sentence-case */
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
	callRemoteModel,
	callRemoteModelStream,
	refreshAvailableModels,
	rewriteRetrievalQuery,
} from './llm/chat';
import { AgentRunner } from './agent/agent-runner';
import { ToolExecutor } from './agent/tool-executor';
import { ToolRegistry } from './agent/tool-registry';
import { ToolExecutionResult } from './agent/types';
import { createDefaultTools } from './agent/tools';
import { IndexManager } from './rag/index-manager';
import { buildLocalAnswer } from './rag/local-answer';
import { buildRuleBasedRewrite } from './rag/query-rewrite';
import { suggestLinks } from './rag/search';
import {
	AgentAnswer,
	AgentStreamEvent,
	FolderClassification,
	FolderClassificationOptions,
	FolderInspection,
	FolderInspectionOptions,
	PreparedQuestion,
	QueryRewrite,
	ResponseTrace,
	SearchResult,
} from './rag/types';
import { RetrievalService } from './services/retrieval-service';
import { VaultNoteService } from './services/vault-note-service';
import {
	DEFAULT_SETTINGS,
	PROVIDER_PRESETS,
	VaultPilotSettingTab,
	VaultPilotSettings,
} from './settings';
import { VaultPilotView, VIEW_TYPE_VAULTPILOT } from './ui/view';

const RETRIEVAL_MODE_LABEL = 'Hybrid retrieval - BM25 0.3 / Embedding 0.7';
const MIN_USABLE_TOP_SCORE = 0.25;

export default class VaultPilotPlugin extends Plugin {
	settings!: VaultPilotSettings;
	indexManager!: IndexManager;
	vaultNoteService!: VaultNoteService;
	retrievalService!: RetrievalService;
	toolRegistry!: ToolRegistry;
	toolExecutor!: ToolExecutor;

	async onload() {
		await this.loadSettings();
		this.indexManager = new IndexManager(this.app.vault, () => this.getEmbeddingSettings());
		this.vaultNoteService = new VaultNoteService(this.app);
		this.retrievalService = new RetrievalService(this);
		this.toolRegistry = new ToolRegistry();
		for (const tool of createDefaultTools()) {
			this.toolRegistry.register(tool);
		}
		this.toolExecutor = new ToolExecutor(this.toolRegistry);

		this.registerView(VIEW_TYPE_VAULTPILOT, (leaf) => new VaultPilotView(leaf, this));

		this.addRibbonIcon('bot', 'Open VaultPilot', async () => {
			await this.activateView();
		});

		this.addCommand({
			id: 'open-agent',
			name: 'Open agent',
			callback: async () => {
				await this.activateView();
			},
		});

		this.addCommand({
			id: 'suggest-links-for-current-note',
			name: 'Suggest links for current note',
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return false;
				}
				if (!checking) {
					void this.activateView()
						.then(() => {
							const view = this.getVaultPilotView();
							void view?.suggestLinksFor(file);
						})
						.catch((error) => {
							console.error(error);
						});
				}
				return true;
			},
		});

		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild index',
			callback: async () => {
				const stats = await this.indexManager.rebuild();
				new Notice(`VaultPilot indexed ${stats.fileCount} notes and ${stats.chunkCount} chunks.`);
			},
		});

		this.addCommand({
			id: 'clear-index-cache',
			name: 'Clear index cache',
			callback: async () => {
				await this.indexManager.clear();
				new Notice('VaultPilot index cache cleared.');
			},
		});

		this.addSettingTab(new VaultPilotSettingTab(this.app, this));
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULTPILOT)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice('VaultPilot could not open a sidebar pane.');
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_VAULTPILOT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getActiveMarkdownFile(): TFile | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	}

	async searchNotes(query: string, limit = this.settings.maxResults): Promise<SearchResult[]> {
		return this.indexManager.search(query, limit);
	}

	async searchNotesMany(queries: string[], limit = this.settings.maxResults): Promise<SearchResult[]> {
		return this.indexManager.searchMany(queries, limit);
	}

	async inspectFolder(options: FolderInspectionOptions): Promise<FolderInspection> {
		return this.indexManager.inspectFolder(options);
	}

	async classifyFolderFiles(options: FolderClassificationOptions): Promise<FolderClassification> {
		return this.indexManager.classifyFolderFiles(options);
	}

	async answerQuestion(question: string): Promise<AgentAnswer> {
		if (this.canUseToolCalling()) {
			try {
				return await this.answerQuestionWithTools(question);
			} catch (error) {
				console.debug('VaultPilot tool calling failed. Falling back to fixed RAG.', error);
			}
		}

		const { activeFile, activeContent, results, trace } = await this.prepareQuestion(question);

		if (this.settings.provider !== 'local' && !this.settings.apiKey.trim()) {
			return this.missingApiKeyAnswer(question, activeFile, results, trace);
		}

		if (this.settings.provider !== 'local') {
			try {
				const remoteAnswer = await callRemoteModel(
					this.getChatClientOptions(),
					question,
					results,
					activeFile,
					activeContent,
				);
				const cleaned = cleanAnswerForDisplay(remoteAnswer.answer, remoteAnswer.reasoning);
				return { answer: cleaned.answer, results, mode: 'remote', trace: addModelProcess(trace, cleaned.process) };
			} catch (error) {
				return this.remoteFailureAnswer(question, activeFile, results, trace, error);
			}
		}

		return {
			answer: buildLocalAnswer(question, results, activeFile),
			results,
			mode: 'local',
			trace,
		};
	}

	async streamAnswerQuestion(question: string, onEvent: (event: AgentStreamEvent) => void): Promise<AgentAnswer> {
		if (this.settings.provider === 'local') {
			onEvent({ type: 'status', label: 'Searching notes' });
			const { activeFile, results, trace } = await this.prepareQuestion(question);
			return {
				answer: buildLocalAnswer(question, results, activeFile),
				results,
				mode: 'local',
				trace,
			};
		}

		if (!this.settings.apiKey.trim()) {
			const { activeFile, results, trace } = await this.prepareQuestion(question);
			return this.missingApiKeyAnswer(question, activeFile, results, trace);
		}

		if (this.canUseToolCalling()) {
			try {
				onEvent({ type: 'status', label: 'Choosing tools' });
				const answer = await this.answerQuestionWithTools(question, onEvent);
				return answer;
			} catch (error) {
				console.error(error);
				new Notice('VaultPilot tool calling failed. Falling back to fixed RAG.');
				onEvent({ type: 'status', label: 'Searching notes' });
			}
		}

		const prepared = await this.prepareQuestion(question);
		const { activeFile, activeContent, results } = prepared;
		const trace = prepared.trace;
		onEvent({ type: 'status', label: 'Preparing answer' });

		try {
			onEvent({ type: 'status', label: 'Writing answer' });
			const gate = createAnswerStreamGate(onEvent);
			const remoteAnswer = await callRemoteModelStream(
				this.getChatClientOptions(),
				question,
				results,
				activeFile,
				activeContent,
				(event) => {
					if (event.type === 'process') {
						onEvent({ type: 'process', delta: event.delta });
						return;
					}
					gate.push(event.delta);
				},
			);
			gate.flush();
			const cleaned = cleanAnswerForDisplay(remoteAnswer.answer, remoteAnswer.reasoning);
			return { answer: cleaned.answer, results, mode: 'remote', trace: addModelProcess(trace, cleaned.process) };
		} catch (error) {
			console.error(error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice('VaultPilot streaming failed. Falling back to normal response.');

			try {
				const remoteAnswer = await callRemoteModel(
					this.getChatClientOptions(),
					question,
					results,
					activeFile,
					activeContent,
				);
				const cleaned = cleanAnswerForDisplay(remoteAnswer.answer, remoteAnswer.reasoning);
				return {
					answer: cleaned.answer,
					results,
					mode: 'remote',
					trace: addModelProcess(addTraceWarning(trace, message), cleaned.process),
					warning: message,
				};
			} catch (fallbackError) {
				const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
				return {
					answer: [
						'Remote model call failed, so VaultPilot used local search instead.',
						`Streaming failure: ${message}`,
						`Fallback request failure: ${fallbackMessage}`,
						buildLocalAnswer(question, results, activeFile),
					].join('\n\n'),
					results,
					mode: 'local',
					trace: addTraceWarning(addTraceWarning(trace, message), fallbackMessage),
					warning: fallbackMessage,
				};
			}
		}
	}

	async suggestLinks(file: TFile): Promise<SearchResult[]> {
		return suggestLinks(
			this.app.vault,
			file,
			this.settings.maxResults,
			(query, limit) => this.searchNotes(query, limit),
		);
	}

	async prepareQuestion(question: string): Promise<PreparedQuestion> {
		const totalStartedAt = Date.now();
		const activeFile = this.getActiveMarkdownFile();
		const activeContent =
			activeFile && this.settings.includeCurrentNote
				? await this.app.vault.cachedRead(activeFile)
				: '';

		const understandingStartedAt = Date.now();
		const rewrite = await this.rewriteQuestion(question, activeFile, activeContent);
		const understandingMs = Date.now() - understandingStartedAt;

		const retrievalStartedAt = Date.now();
		const results = await this.searchNotesMany(rewrite.rewrittenQueries);
		const retrievalMs = Date.now() - retrievalStartedAt;
		const trace = buildTrace(rewrite, results, understandingMs, retrievalMs, Date.now() - totalStartedAt);
		return { activeFile, activeContent, results, trace };
	}

	private async answerQuestionWithTools(
		question: string,
		onEvent?: (event: AgentStreamEvent) => void,
	): Promise<AgentAnswer> {
		const runner = new AgentRunner(
			this.getChatClientOptions(),
			this.toolRegistry,
			this.toolExecutor,
			{
				vaultNotes: this.vaultNoteService,
				retrieval: this.retrievalService,
				maxResults: this.settings.maxResults,
			},
		);
		const result = await runner.run({ question, onEvent });
		return {
			answer: result.answer,
			results: result.results,
			mode: 'remote',
			trace: buildAgentTrace(question, result.results, result.toolResults, result.process, result.durationMs, result.warnings),
			warning: result.warnings.join('; ') || undefined,
		};
	}

	async refreshAvailableModels(): Promise<string[]> {
		return refreshAvailableModels(this.getChatClientOptions());
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<VaultPilotSettings>,
		);
		this.normalizeSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private missingApiKeyAnswer(
		question: string,
		activeFile: TFile | null,
		results: SearchResult[],
		trace: ResponseTrace,
	): AgentAnswer {
		return {
			answer: [
				'Remote model mode is selected, but no API key is configured.',
				'Add an API key in VaultPilot settings, or switch back to Local search.',
				buildLocalAnswer(question, results, activeFile),
			].join('\n\n'),
			results,
			mode: 'local',
			trace: addTraceWarning(trace, 'Missing API key'),
			warning: 'Missing API key',
		};
	}

	private remoteFailureAnswer(
		question: string,
		activeFile: TFile | null,
		results: SearchResult[],
		trace: ResponseTrace,
		error: unknown,
	): AgentAnswer {
		console.error(error);
		const message = error instanceof Error ? error.message : String(error);
		new Notice('VaultPilot remote model failed. Falling back to local mode.');
		return {
			answer: [
				'Remote model call failed, so VaultPilot used local search instead.',
				`Failure reason: ${message}`,
				buildLocalAnswer(question, results, activeFile),
			].join('\n\n'),
			results,
			mode: 'local',
			trace: addTraceWarning(trace, message),
			warning: message,
		};
	}

	private async rewriteQuestion(question: string, activeFile: TFile | null, activeContent: string): Promise<QueryRewrite> {
		if (this.settings.provider === 'local' || !this.settings.apiKey.trim()) {
			return buildRuleBasedRewrite(question, activeFile, activeContent);
		}

		try {
			return await rewriteRetrievalQuery(
				this.getChatClientOptions(),
				question,
				activeFile,
				activeContent,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.debug('VaultPilot query rewrite failed. Falling back to rule-based rewrite.', error);
			return buildRuleBasedRewrite(question, activeFile, activeContent, message);
		}
	}

	private getVaultPilotView(): VaultPilotView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULTPILOT)[0];
		const view = leaf?.view;
		return view instanceof VaultPilotView ? view : null;
	}

	private getChatClientOptions() {
		return {
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
		};
	}

	private canUseToolCalling(): boolean {
		return this.settings.provider !== 'local' && Boolean(this.settings.apiKey.trim());
	}

	private getEmbeddingSettings() {
		return {
			enabled: this.settings.embeddingEnabled,
			provider: 'ollama' as const,
			endpoint: this.settings.embeddingEndpoint,
			model: this.settings.embeddingModel,
			batchSize: this.settings.embeddingBatchSize,
		};
	}

	private normalizeSettings() {
		const legacyProvider = this.settings.provider as string;
		if (legacyProvider === 'openai-compatible') {
			this.settings.provider = this.settings.endpoint.includes('api.deepseek.com') ? 'deepseek' : 'custom';
		}
		if (!Array.isArray(this.settings.availableModels)) {
			this.settings.availableModels = [];
		}
		this.settings.embeddingEnabled ??= true;
		this.settings.embeddingEndpoint ||= 'http://localhost:11434/api/embed';
		this.settings.embeddingModel ||= 'nomic-embed-text';
		this.settings.embeddingBatchSize ||= 8;
		if (!this.settings.modelsEndpoint) {
			this.settings.modelsEndpoint = this.settings.provider === 'deepseek'
				? PROVIDER_PRESETS.deepseek.modelsEndpoint
				: '';
		}
		if (this.settings.provider === 'deepseek') {
			this.settings.endpoint = PROVIDER_PRESETS.deepseek.endpoint;
			if (this.settings.availableModels.length === 0) {
				this.settings.availableModels = PROVIDER_PRESETS.deepseek.suggestedModels;
			}
		}
	}
}

function buildTrace(
	rewrite: QueryRewrite,
	results: SearchResult[],
	understandingMs: number,
	retrievalMs: number,
	totalMs: number,
): ResponseTrace {
	return {
		originalQuestion: rewrite.originalQuestion,
		rewrittenQuery: rewrite.rewrittenQueries.join('\n'),
		rewriteMethod: rewrite.method,
		retrievalMode: RETRIEVAL_MODE_LABEL,
		sourceCount: results.length,
		sources: results.map((result) => ({
			title: result.file.basename,
			path: result.file.path,
			score: result.score,
			excerpt: result.excerpt,
			section: result.chunk?.headingPath.join(' > ') || result.chunk?.title,
			lines: result.chunk ? `${result.chunk.startLine}-${result.chunk.endLine}` : undefined,
			matches: result.matches,
		})),
		confidenceSummary: summarizeRetrievalConfidence(results),
		modelProcess: [],
		timings: {
			understandingMs,
			retrievalMs,
			totalMs,
		},
		warnings: rewrite.warning ? [rewrite.warning] : [],
	};
}

function buildAgentTrace(
	question: string,
	results: SearchResult[],
	toolResults: ToolExecutionResult[],
	process: string[],
	totalMs: number,
	warnings: string[],
): ResponseTrace {
	const searchQueries = Array.from(
		new Set(toolResults.flatMap((result) => result.searchQueries ?? [])),
	);
	return {
		originalQuestion: question,
		rewrittenQuery: searchQueries.join('\n') || question,
		rewriteMethod: 'agent-tool',
		retrievalMode: RETRIEVAL_MODE_LABEL,
		sourceCount: results.length,
		sources: results.map((result) => ({
			title: result.file.basename,
			path: result.file.path,
			score: result.score,
			excerpt: result.excerpt,
			section: result.chunk?.headingPath.join(' > ') || result.chunk?.title,
			lines: result.chunk ? `${result.chunk.startLine}-${result.chunk.endLine}` : undefined,
			matches: result.matches,
		})),
		toolCalls: toolResults.map((result) => ({
			name: result.call.name,
			ok: result.ok,
			input: summarizeToolInput(result.call.input),
			summary: summarizeToolOutput(result),
			durationMs: result.durationMs,
			error: result.error,
		})),
		confidenceSummary: summarizeRetrievalConfidence(results),
		modelProcess: process,
		timings: {
			understandingMs: 0,
			retrievalMs: toolResults.reduce((sum, result) => sum + result.durationMs, 0),
			totalMs,
		},
		warnings,
	};
}

function summarizeRetrievalConfidence(results: SearchResult[]): string {
	if (results.length === 0) {
		return 'No reliable vault evidence found.';
	}
	const topScore = results[0]?.score ?? 0;
	if (topScore < MIN_USABLE_TOP_SCORE) {
		return 'Retrieved candidates look weak. Treat the answer as tentative.';
	}
	if (topScore >= 0.75 || results.length >= 3) {
		return 'Vault evidence looks usable. Review sources before relying on details.';
	}
	return 'Vault evidence is thin. Treat the answer as tentative.';
}

function addTraceWarning(trace: ResponseTrace, warning: string): ResponseTrace {
	return {
		...trace,
		warnings: Array.from(new Set([...trace.warnings, warning])),
	};
}

function addModelProcess(trace: ResponseTrace, process: string[]): ResponseTrace {
	if (process.length === 0) {
		return trace;
	}
	return {
		...trace,
		modelProcess: [...trace.modelProcess, ...process],
	};
}

function summarizeToolInput(input: unknown): string {
	if (typeof input === 'string') {
		return input;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}

function summarizeToolOutput(result: ToolExecutionResult): string {
	if (!result.ok) {
		return result.error ?? 'Tool failed';
	}
	if (result.call.name === 'inspect_folder' && isRecord(result.output)) {
		const fileCount = typeof result.output.fileCount === 'number' ? result.output.fileCount : 0;
		const chunkCount = typeof result.output.chunkCount === 'number' ? result.output.chunkCount : 0;
		return `Inspected ${fileCount} file${fileCount === 1 ? '' : 's'} and ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}`;
	}
	if (result.call.name === 'classify_folder_files' && isRecord(result.output)) {
		const totalFiles = typeof result.output.totalFiles === 'number' ? result.output.totalFiles : 0;
		const matchedFileCount = typeof result.output.matchedFileCount === 'number' ? result.output.matchedFileCount : 0;
		const uncertainFileCount = typeof result.output.uncertainFileCount === 'number' ? result.output.uncertainFileCount : 0;
		return `Classified ${totalFiles} file${totalFiles === 1 ? '' : 's'}; matched ${matchedFileCount}, uncertain ${uncertainFileCount}`;
	}
	if (result.results) {
		return `Returned ${result.results.length} result${result.results.length === 1 ? '' : 's'}`;
	}
	return 'Completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function cleanAnswerForDisplay(answer: string, reasoning: string): { answer: string; process: string[] } {
	const process = reasoning.trim() ? [reasoning.trim()] : [];
	const paragraphs = answer
		.split(/\n{2,}/u)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);

	while (paragraphs.length > 1 && isProcessParagraph(paragraphs[0] ?? '')) {
		const shifted = paragraphs.shift();
		if (shifted) {
			process.push(shifted);
		}
	}

	const cleaned = paragraphs.join('\n\n').replace(/^\u56de\u7b54[:\uff1a]\s*/u, '').trim();
	return {
		answer: cleaned || answer.trim(),
		process,
	};
}

function createAnswerStreamGate(onEvent: (event: AgentStreamEvent) => void): { push: (delta: string) => void; flush: () => void } {
	let answerGateOpen = false;
	let pendingAnswer = '';

	return {
		push(delta: string) {
			if (answerGateOpen) {
				onEvent({ type: 'answer', delta });
				return;
			}

			pendingAnswer += delta;
			const firstParagraphComplete = /\n{2,}/u.test(pendingAnswer);
			if (!firstParagraphComplete && pendingAnswer.length <= 160) {
				return;
			}

			const parts = pendingAnswer.split(/\n{2,}/u);
			while (parts.length > 1 && isProcessParagraph(parts[0]?.trim() ?? '')) {
				const processParagraph = parts.shift()?.trim();
				if (processParagraph) {
					onEvent({ type: 'process', delta: `\n\n${processParagraph}` });
				}
			}

			pendingAnswer = parts.join('\n\n');
			if (pendingAnswer && (!isProcessParagraph(pendingAnswer) || firstParagraphComplete)) {
				answerGateOpen = true;
				onEvent({ type: 'answer', delta: pendingAnswer });
				pendingAnswer = '';
			}
		},
		flush() {
			if (pendingAnswer) {
				if (isProcessParagraph(pendingAnswer)) {
					onEvent({ type: 'process', delta: `\n\n${pendingAnswer.trim()}` });
				} else {
					onEvent({ type: 'answer', delta: pendingAnswer });
				}
				pendingAnswer = '';
			}
		},
	};
}

function isProcessParagraph(paragraph: string): boolean {
	const normalized = paragraph.toLowerCase();
	return [
		'\u6211\u4eec\u6839\u636e',
		'\u6211\u6839\u636e',
		'\u9700\u8981\u603b\u7ed3',
		'\u9700\u8981\u5148',
		'\u63d0\u4f9b\u7684\u7b14\u8bb0',
		'\u6839\u636e\u63d0\u4f9b',
		'\u7528\u6237\u95ee',
		'\u7528\u6237\u7684\u95ee\u9898',
		'\u5148\u5206\u6790',
		'i will',
		'i need to',
		'based on the provided',
		'the provided notes',
	].some((marker) => normalized.includes(marker));
}
