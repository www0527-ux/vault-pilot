/* eslint-disable obsidianmd/ui/sentence-case */
import { ItemView, MarkdownRenderer, TFile, WorkspaceLeaf } from 'obsidian';
import { IndexStats } from '../rag/index-manager';
import { AgentAnswer, SearchResult } from '../rag/types';
import type VaultPilotPlugin from '../main';

export const VIEW_TYPE_VAULTPILOT = 'vaultpilot-agent-view';

export class VaultPilotView extends ItemView {
	private plugin: VaultPilotPlugin;
	private inputEl!: HTMLTextAreaElement;
	private messagesEl!: HTMLElement;
	private indexStatusEl!: HTMLElement;
	private latestIndexStats: IndexStats | null = null;
	private stopIndexListener: (() => void) | null = null;
	private statusTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultPilotPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_VAULTPILOT;
	}

	getDisplayText() {
		return 'VaultPilot';
	}

	getIcon() {
		return 'bot';
	}

	async onOpen() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('vaultpilot-view');

		const header = containerEl.createDiv({ cls: 'vaultpilot-header' });
		header.createEl('h2', { text: 'VaultPilot' });
		header.createEl('p', { text: 'Ask naturally. VaultPilot will use your notes when they help.' });
		this.indexStatusEl = header.createDiv({ cls: 'vaultpilot-index-status' });
		this.stopIndexListener = this.plugin.indexManager.onChange((stats) => {
			this.latestIndexStats = stats;
			this.renderIndexStatus(stats);
		});
		void this.plugin.indexManager.ensureReady().catch((error) => {
			console.error(error);
		});

		this.messagesEl = containerEl.createDiv({ cls: 'vaultpilot-messages' });
		this.addMessage(
			'assistant',
			'Hi. Ask me about this vault, or ask for related notes, project context, or an explanation of the current note.',
		);

		this.inputEl = containerEl.createEl('textarea', {
			cls: 'vaultpilot-input',
			attr: { placeholder: 'Ask VaultPilot...' },
		});

		const footer = containerEl.createDiv({ cls: 'vaultpilot-footer' });
		const sendButton = footer.createEl('button', { text: 'Ask VaultPilot' });
		sendButton.addEventListener('click', () => {
			const question = this.inputEl.value.trim();
			if (question) {
				void this.ask(question);
			}
		});

		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				const question = this.inputEl.value.trim();
				if (question) {
					void this.ask(question);
				}
			}
		});
	}

	async onClose() {
		this.stopIndexListener?.();
		this.stopIndexListener = null;
		this.stopStatusTimer();
	}

	async ask(question: string) {
		this.inputEl.value = '';
		this.addMessage('user', question);
		const loading = this.addMessage('assistant', '');
		const live = this.renderLiveAnswerShell(loading);
		let liveAnswer = '';
		let liveProcess = '';

		const answer = await this.plugin.streamAnswerQuestion(question, (event) => {
			if (event.type === 'status') {
				this.updateLiveStatus(live.statusTitle, event.label);
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'process') {
				liveProcess += event.delta;
				this.updateLiveProcess(live.processEl, liveProcess);
				this.scrollMessagesToBottom();
				return;
			}
			liveAnswer += event.delta;
			this.updateLiveAnswer(live.answerEl, liveAnswer);
			this.scrollMessagesToBottom();
		});
		await this.renderAssistantAnswer(loading, answer);
		this.scrollMessagesToBottom();
	}

	async suggestLinksFor(file: TFile) {
		this.addMessage('user', `Suggest links for [[${file.basename}]]`);
		const loading = this.addMessage('assistant', 'Searching for related notes...');
		const suggestions = await this.plugin.suggestLinks(file);

		if (suggestions.length === 0) {
			loading.setText('I did not find strong link suggestions yet. Add more headings, tags, or related notes and try again.');
			return;
		}

		const lines = suggestions.map((result) => {
			return `- [[${result.file.basename}]] - ${result.matches.join(', ') || 'related context'}`;
		});
		loading.setText(`Suggested links for [[${file.basename}]]:\n\n${lines.join('\n')}`);
		this.scrollMessagesToBottom();
	}

	private addMessage(role: 'assistant' | 'user', text: string): HTMLElement {
		const message = this.messagesEl.createDiv({ cls: `vaultpilot-message vaultpilot-message-${role}` });
		message.setText(text);
		this.scrollMessagesToBottom();
		return message;
	}

	private async renderAssistantAnswer(message: HTMLElement, answer: AgentAnswer) {
		message.empty();
		this.renderProcessSummary(message, answer);

		const markdownEl = message.createDiv({ cls: 'vaultpilot-message-markdown markdown-rendered' });
		await MarkdownRenderer.render(
			this.app,
			answer.answer,
			markdownEl,
			this.plugin.getActiveMarkdownFile()?.path ?? 'VaultPilot.md',
			this,
		);

		this.renderSources(message, answer.results);
	}

	private renderLiveAnswerShell(message: HTMLElement): {
		statusTitle: HTMLElement;
		processEl: HTMLElement;
		answerEl: HTMLElement;
	} {
		message.empty();
		const status = message.createEl('details', { cls: 'vaultpilot-process-summary is-working', attr: { open: 'true' } });
		const summary = status.createEl('summary');
		summary.createSpan({ cls: 'vaultpilot-process-spinner' });
		const statusTitle = summary.createSpan({ cls: 'vaultpilot-process-title', text: 'Working' });
		const steps = status.createDiv({ cls: 'vaultpilot-process-steps' });
		steps.createSpan({ text: 'Understand question' });
		steps.createSpan({ text: 'Search notes' });
		steps.createSpan({ text: 'Prepare answer' });
		const processEl = status.createDiv({ cls: 'vaultpilot-live-process' });
		const answerEl = message.createDiv({ cls: 'vaultpilot-message-markdown markdown-rendered vaultpilot-live-answer' });
		return { statusTitle, processEl, answerEl };
	}

	private updateLiveStatus(statusTitle: HTMLElement, label: string) {
		statusTitle.setText(label);
	}

	private updateLiveProcess(processEl: HTMLElement, process: string) {
		processEl.setText(process.trim());
	}

	private updateLiveAnswer(answerEl: HTMLElement, answer: string) {
		answerEl.setText(answer);
	}

	private renderProcessSummary(message: HTMLElement, answer: AgentAnswer) {
		const details = message.createEl('details', { cls: 'vaultpilot-process-summary' });
		const summary = details.createEl('summary');
		summary.createSpan({ cls: 'vaultpilot-process-check', text: 'OK' });
		summary.createSpan({
			cls: 'vaultpilot-process-title',
			text: buildProcessSummaryText(answer),
		});
		summary.createSpan({
			cls: 'vaultpilot-process-time',
			text: formatElapsed(answer.trace.timings.totalMs),
		});

		const grid = details.createDiv({ cls: 'vaultpilot-trace-grid' });
		this.renderTraceRow(grid, 'Original question', answer.trace.originalQuestion);
		this.renderTraceRow(grid, 'Retrieval query', answer.trace.rewrittenQuery);
		this.renderTraceRow(grid, 'Rewrite method', answer.trace.rewriteMethod);
		this.renderTraceRow(grid, 'Retrieval mode', answer.trace.retrievalMode);
		this.renderTraceRow(grid, 'References', `${answer.trace.sourceCount}`);
		this.renderTraceRow(grid, 'Confidence', answer.trace.confidenceSummary);
		if (answer.trace.toolCalls && answer.trace.toolCalls.length > 0) {
			this.renderTraceRow(grid, 'Tool calls', answer.trace.toolCalls.map(formatToolCall).join('\n\n'));
		}
		this.renderTraceRow(
			grid,
			'Timing',
			`understanding ${formatElapsed(answer.trace.timings.understandingMs)}, retrieval ${formatElapsed(answer.trace.timings.retrievalMs)}, total ${formatElapsed(answer.trace.timings.totalMs)}`,
		);
		if (answer.trace.modelProcess.length > 0) {
			this.renderTraceRow(grid, 'Model process', answer.trace.modelProcess.join('\n\n'));
		}
		if (answer.trace.warnings.length > 0) {
			this.renderTraceRow(grid, 'Warnings', answer.trace.warnings.join('; '));
		}
	}

	private renderSources(message: HTMLElement, results: SearchResult[]) {
		const section = message.createDiv({ cls: 'vaultpilot-sources' });
		section.createEl('h3', { text: 'Sources' });

		if (results.length === 0) {
			section.createDiv({ cls: 'vaultpilot-source-empty', text: 'No reliable vault sources were found.' });
			return;
		}

		for (const [index, result] of results.entries()) {
			const item = section.createDiv({ cls: 'vaultpilot-source-item' });
			const titleRow = item.createDiv({ cls: 'vaultpilot-source-title-row' });
			titleRow.createSpan({ cls: 'vaultpilot-source-rank', text: `${index + 1}.` });
			const openButton = titleRow.createEl('button', {
				cls: 'vaultpilot-source-open',
				text: result.file.basename,
			});
			openButton.addEventListener('click', () => {
				void this.app.workspace.getLeaf(false).openFile(result.file);
			});

			if (result.chunk) {
				item.createDiv({
					cls: 'vaultpilot-source-meta',
					text: `${result.chunk.headingPath.join(' > ') || result.chunk.title} - lines ${result.chunk.startLine}-${result.chunk.endLine}`,
				});
			}
			item.createDiv({
				cls: 'vaultpilot-source-excerpt',
				text: result.excerpt || '(empty excerpt)',
			});
		}
	}

	private renderTraceRow(container: HTMLElement, label: string, value: string) {
		container.createDiv({ cls: 'vaultpilot-trace-label', text: label });
		container.createDiv({ cls: 'vaultpilot-trace-value', text: value });
	}

	private renderIndexStatus(stats: IndexStats) {
		this.indexStatusEl.empty();
		const isBusy = stats.status === 'building' || stats.status === 'loading';
		this.indexStatusEl.toggleClass('is-building', isBusy);

		if (stats.status === 'loading') {
			this.indexStatusEl.createSpan({ cls: 'vaultpilot-spinner' });
			this.indexStatusEl.createSpan({
				text: `Loading index from cache - ${stats.fileCount} notes - ${formatElapsed(stats.elapsedMs)}`,
			});
			this.startStatusTimer();
			return;
		}

		if (stats.status === 'building') {
			this.indexStatusEl.createSpan({ cls: 'vaultpilot-spinner' });
			this.indexStatusEl.createSpan({
				text: `Building index - ${stats.fileCount} notes - ${formatElapsed(stats.elapsedMs)}`,
			});
			this.startStatusTimer();
			return;
		}

		this.stopStatusTimer();
		if (stats.status === 'ready') {
			const sourceLabel = stats.source === 'disk' ? 'cache' : 'rebuilt';
			this.indexStatusEl.createSpan({
				text: `Indexed ${stats.fileCount} notes - ${stats.chunkCount} chunks - ${stats.embeddingCount} embeddings - ${sourceLabel} - ${formatElapsed(stats.elapsedMs)}`,
			});
			return;
		}

		this.indexStatusEl.createSpan({ text: `Index not built - ${stats.fileCount} notes` });
	}

	private startStatusTimer() {
		if (this.statusTimer !== null) {
			return;
		}
		this.statusTimer = window.setInterval(() => {
			if (this.latestIndexStats?.status === 'building' || this.latestIndexStats?.status === 'loading') {
				this.latestIndexStats = this.plugin.indexManager.getStats();
				this.renderIndexStatus(this.latestIndexStats);
			}
		}, 250);
	}

	private stopStatusTimer() {
		if (this.statusTimer === null) {
			return;
		}
		window.clearInterval(this.statusTimer);
		this.statusTimer = null;
	}

	private scrollMessagesToBottom() {
		const viewWindow = this.containerEl.ownerDocument.defaultView ?? window;
		viewWindow.requestAnimationFrame(() => {
			this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
		});
	}
}

function formatElapsed(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

function buildProcessSummaryText(answer: AgentAnswer): string {
	const count = answer.results.length;
	if (count === 0) {
		return 'Processed, no reliable references found';
	}
	if (answer.trace.confidenceSummary.toLowerCase().includes('weak')) {
		return `Found ${count} weak candidate reference${count === 1 ? '' : 's'}`;
	}
	if (answer.mode === 'remote') {
		return `Answered using ${count} reference${count === 1 ? '' : 's'}`;
	}
	return `Found ${count} candidate reference${count === 1 ? '' : 's'}`;
}

function formatToolCall(toolCall: NonNullable<AgentAnswer['trace']['toolCalls']>[number]): string {
	const status = toolCall.ok ? 'OK' : 'Failed';
	const lines = [
		`${status} ${toolCall.name} (${formatElapsed(toolCall.durationMs)})`,
		`Input: ${toolCall.input}`,
		toolCall.summary,
	];
	if (toolCall.error) {
		lines.push(`Error: ${toolCall.error}`);
	}
	return lines.join('\n');
}
