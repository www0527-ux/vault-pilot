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
		const activeToolRows = new Map<string, HTMLElement[]>();

		const answer = await this.plugin.streamAnswerQuestion(question, (event) => {
			if (event.type === 'status') {
				const title = userFacingStatus(event.label);
				this.updateLiveStatus(live.statusTitle, title);
				if (event.label === 'Writing answer' || event.label === 'Preparing answer') {
					this.appendLiveTimelineEvent(live.timelineEl, 'running', title, '');
				}
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'step_start') {
				this.updateLiveStatus(live.statusTitle, userFacingStatus(event.label));
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'step_finish') {
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'step_error') {
				this.appendLiveTimelineEvent(
					live.timelineEl,
					'error',
					userFacingStatus(event.label),
					`${event.error} (${formatElapsed(event.durationMs)})`,
				);
				this.updateLiveStatus(live.statusTitle, 'Stopped');
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'process') {
				liveProcess += event.delta;
				this.updateLiveProcess(live.processEl, liveProcess);
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'tool_start') {
				const title = buildToolActivityTitle(event.name, event.inputSummary);
				this.updateLiveStatus(live.statusTitle, title);
				const row = this.appendLiveTimelineEvent(
					live.timelineEl,
					'running',
					title,
					buildToolActivityDetail(event.name, event.inputSummary),
				);
				const rows = activeToolRows.get(event.name) ?? [];
				rows.push(row);
				activeToolRows.set(event.name, rows);
				this.scrollMessagesToBottom();
				return;
			}
			if (event.type === 'tool_result') {
				const rows = activeToolRows.get(event.name) ?? [];
				const row = rows.shift();
				if (rows.length === 0) {
					activeToolRows.delete(event.name);
				} else {
					activeToolRows.set(event.name, rows);
				}
				const title = buildToolResultTitle(event.name, event.ok);
				const detail = `${event.error ?? event.summary}${event.summary || event.error ? '\n' : ''}${formatElapsed(event.durationMs)}`;
				if (row) {
					this.updateLiveTimelineEvent(row, event.ok ? 'done' : 'error', title, detail);
				} else {
					this.appendLiveTimelineEvent(live.timelineEl, event.ok ? 'done' : 'error', title, detail);
				}
				this.updateLiveStatus(
					live.statusTitle,
					event.ok ? `${formatToolName(event.name)} complete` : `${formatToolName(event.name)} failed`,
				);
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
		timelineEl: HTMLElement;
		processEl: HTMLElement;
		answerEl: HTMLElement;
	} {
		message.empty();
		const status = message.createEl('details', { cls: 'vaultpilot-process-summary is-working' });
		const summary = status.createEl('summary');
		summary.createSpan({ cls: 'vaultpilot-process-spinner' });
		const statusTitle = summary.createSpan({ cls: 'vaultpilot-process-title', text: 'Working' });
		const timelineEl = status.createDiv({ cls: 'vaultpilot-live-timeline' });
		this.appendLiveTimelineEvent(timelineEl, 'running', 'Understanding question', '');
		const processEl = status.createDiv({ cls: 'vaultpilot-live-process' });
		const answerEl = message.createDiv({ cls: 'vaultpilot-message-markdown markdown-rendered vaultpilot-live-answer' });
		return { statusTitle, timelineEl, processEl, answerEl };
	}

	private updateLiveStatus(statusTitle: HTMLElement, label: string) {
		statusTitle.setText(label);
	}

	private appendLiveTimelineEvent(container: HTMLElement, kind: 'running' | 'done' | 'error', title: string, detail: string): HTMLElement {
		const row = container.createDiv({ cls: `vaultpilot-live-step vaultpilot-live-step-${kind}` });
		row.createSpan({ cls: 'vaultpilot-live-step-dot' });
		const body = row.createDiv({ cls: 'vaultpilot-live-step-body' });
		body.createDiv({ cls: 'vaultpilot-live-step-title', text: title });
		if (detail.trim()) {
			body.createDiv({ cls: 'vaultpilot-live-step-detail', text: detail.trim() });
		}
		return row;
	}

	private updateLiveTimelineEvent(row: HTMLElement, kind: 'done' | 'error', title: string, detail: string) {
		row.removeClass('vaultpilot-live-step-running');
		row.removeClass('vaultpilot-live-step-done');
		row.removeClass('vaultpilot-live-step-error');
		row.addClass(`vaultpilot-live-step-${kind}`);
		const titleEl = row.querySelector('.vaultpilot-live-step-title');
		if (titleEl instanceof HTMLElement) {
			titleEl.setText(title);
		}
		const body = row.querySelector('.vaultpilot-live-step-body');
		if (!(body instanceof HTMLElement)) {
			return;
		}
		let detailEl = row.querySelector('.vaultpilot-live-step-detail');
		if (detail.trim()) {
			if (!(detailEl instanceof HTMLElement)) {
				detailEl = body.createDiv({ cls: 'vaultpilot-live-step-detail' });
			}
			detailEl.setText(detail.trim());
		} else if (detailEl instanceof HTMLElement) {
			detailEl.remove();
		}
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
		const hasWarning = answer.trace.warnings.length > 0;
		summary.createSpan({
			cls: `vaultpilot-process-check ${hasWarning ? 'is-warning' : ''}`,
			text: hasWarning ? '!' : 'OK',
		});
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
		const section = message.createEl('details', { cls: 'vaultpilot-sources' });
		const summary = section.createEl('summary');
		summary.createSpan({
			cls: 'vaultpilot-sources-title',
			text: results.length === 0
				? 'Sources'
				: `Sources (${results.length})`,
		});

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
	if (answer.trace.warnings.includes('Tool-call step limit reached')) {
		return count === 0
			? 'Stopped after tool limit'
			: `Stopped after tool limit with ${count} reference${count === 1 ? '' : 's'}`;
	}
	if (answer.trace.warnings.length > 0) {
		return count === 0
			? 'Finished with warnings'
			: `Finished with warnings and ${count} reference${count === 1 ? '' : 's'}`;
	}
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

function userFacingStatus(label: string): string {
	if (label === 'Choosing tools') {
		return 'Choosing what to inspect';
	}
	if (label === 'Reviewing tool results') {
		return 'Reviewing what was found';
	}
	if (label === 'Writing answer') {
		return 'Writing answer';
	}
	if (label === 'Preparing answer') {
		return 'Preparing answer';
	}
	if (label.startsWith('Running ')) {
		return buildToolActivityTitle(label.replace(/^Running\s+/u, ''), '');
	}
	if (label === 'Stopped after tool limit') {
		return 'Stopped';
	}
	return label;
}

function buildToolActivityTitle(name: string, inputSummary: string): string {
	if (name === 'search_notes') {
		return 'Searching notes';
	}
	if (name === 'read_note') {
		return inputSummary ? `Reading ${shortenPath(inputSummary)}` : 'Reading note';
	}
	if (name === 'inspect_folder') {
		return inputSummary ? `Inspecting ${shortenPath(inputSummary)}` : 'Inspecting folder';
	}
	if (name === 'classify_folder_files') {
		return inputSummary ? `Classifying ${inputSummary}` : 'Classifying files';
	}
	if (name === 'get_current_note') {
		return 'Reading current note';
	}
	if (name === 'suggest_links') {
		return 'Finding related notes';
	}
	return `Using ${formatToolName(name)}`;
}

function buildToolActivityDetail(name: string, inputSummary: string): string {
	if (!inputSummary) {
		return '';
	}
	if (name === 'classify_folder_files') {
		return inputSummary;
	}
	if (name === 'search_notes') {
		return `Query: ${inputSummary}`;
	}
	return inputSummary;
}

function buildToolResultTitle(name: string, ok: boolean): string {
	const action = ok ? 'Finished' : 'Failed';
	if (name === 'search_notes') {
		return ok ? 'Finished searching notes' : 'Search failed';
	}
	if (name === 'read_note') {
		return ok ? 'Finished reading note' : 'Could not read note';
	}
	if (name === 'inspect_folder') {
		return ok ? 'Finished inspecting folder' : 'Folder inspection failed';
	}
	if (name === 'classify_folder_files') {
		return ok ? 'Finished classifying files' : 'File classification failed';
	}
	if (name === 'get_current_note') {
		return ok ? 'Finished reading current note' : 'Could not read current note';
	}
	if (name === 'suggest_links') {
		return ok ? 'Finished finding related notes' : 'Could not find related notes';
	}
	return `${action} ${formatToolName(name)}`;
}

function shortenPath(value: string): string {
	const [pathPart] = value.split(',');
	const path = pathPart?.trim() ?? value;
	if (path.length <= 48) {
		return path;
	}
	return `...${path.slice(-45)}`;
}

function formatToolName(name: string): string {
	return name
		.split('_')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}
