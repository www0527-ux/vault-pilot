/* eslint-disable obsidianmd/ui/sentence-case */
import { ItemView, MarkdownRenderer, TFile, WorkspaceLeaf } from 'obsidian';
import { IndexStats } from '../rag/index-manager';
import { SearchResult } from '../rag/types';
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
			'你好。你可以直接问我关于这个 vault 的问题，也可以让我解释项目、整理思路或寻找相关笔记。',
		);

		this.inputEl = containerEl.createEl('textarea', {
			cls: 'vaultpilot-input',
			attr: { placeholder: 'Ask VaultPilot...' },
		});

		const footer = containerEl.createDiv({ cls: 'vaultpilot-footer' });
		const sendButton = footer.createEl('button', { text: 'Ask VaultPilot' });
		sendButton.addEventListener('click', () => {
			const question = this.inputEl.value.trim();
			if (!question) {
				return;
			}
			void this.ask(question);
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
		const loading = this.addMessage('assistant', '正在检索你的笔记...');

		let streamedAnswer = '';
		const answer = await this.plugin.streamAnswerQuestion(question, (delta) => {
			streamedAnswer += delta;
			loading.setText(streamedAnswer);
			this.scrollMessagesToBottom();
		});
		await this.renderAssistantAnswer(loading, answer.answer, answer.results);
		this.scrollMessagesToBottom();
	}

	async suggestLinksFor(file: TFile) {
		this.addMessage('user', `Suggest links for [[${file.basename}]]`);
		const loading = this.addMessage('assistant', '正在寻找相关笔记...');
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

	private async renderAssistantAnswer(message: HTMLElement, answer: string, results: SearchResult[]) {
		message.empty();
		const markdownEl = message.createDiv({ cls: 'vaultpilot-message-markdown markdown-rendered' });
		await MarkdownRenderer.render(
			this.app,
			answer,
			markdownEl,
			this.plugin.getActiveMarkdownFile()?.path ?? 'VaultPilot.md',
			this,
		);
		if (results.length === 0) {
			return;
		}

		const links = message.createDiv({ cls: 'vaultpilot-note-links' });
		links.createSpan({ cls: 'vaultpilot-note-links-label', text: '相关笔记' });
		for (const result of results) {
			const link = links.createEl('button', { text: result.file.basename });
			link.addEventListener('click', () => {
				void this.app.workspace.getLeaf(false).openFile(result.file);
			});
		}

		this.renderRetrievalDebug(message, results);
	}

	private renderRetrievalDebug(message: HTMLElement, results: SearchResult[]) {
		const details = message.createEl('details', { cls: 'vaultpilot-retrieval-debug' });
		details.createEl('summary', { text: `Retrieved sources (${results.length})` });

		for (const [index, result] of results.entries()) {
			const item = details.createDiv({ cls: 'vaultpilot-retrieval-debug-item' });
			const header = item.createDiv({ cls: 'vaultpilot-retrieval-debug-header' });
			header.createSpan({
				cls: 'vaultpilot-retrieval-debug-rank',
				text: `${index + 1}`,
			});
			header.createSpan({
				cls: 'vaultpilot-retrieval-debug-path',
				text: result.file.path,
			});
			header.createSpan({
				cls: 'vaultpilot-retrieval-debug-score',
				text: `score ${result.score}`,
			});

			if (result.chunk) {
				item.createDiv({
					cls: 'vaultpilot-retrieval-debug-section',
					text: `section: ${result.chunk.headingPath.join(' > ') || result.chunk.title}`,
				});
				item.createDiv({
					cls: 'vaultpilot-retrieval-debug-lines',
					text: `lines: ${result.chunk.startLine}-${result.chunk.endLine}`,
				});
			}
			item.createDiv({
				cls: 'vaultpilot-retrieval-debug-matches',
				text: `matches: ${result.matches.join(', ') || 'none'}`,
			});
			item.createDiv({
				cls: 'vaultpilot-retrieval-debug-excerpt',
				text: result.excerpt || '(empty excerpt)',
			});
		}
	}

	private renderIndexStatus(stats: IndexStats) {
		this.indexStatusEl.empty();
		const isBusy = stats.status === 'building' || stats.status === 'loading';
		this.indexStatusEl.toggleClass('is-building', isBusy);

		if (stats.status === 'loading') {
			this.indexStatusEl.createSpan({ cls: 'vaultpilot-spinner' });
			this.indexStatusEl.createSpan({
				text: `正在从缓存加载索引 · ${stats.fileCount} notes · ${formatElapsed(stats.elapsedMs)}`,
			});
			this.startStatusTimer();
			return;
		}

		if (stats.status === 'building') {
			this.indexStatusEl.createSpan({ cls: 'vaultpilot-spinner' });
			this.indexStatusEl.createSpan({
				text: `初次加载数据构建中 · ${stats.fileCount} notes · ${formatElapsed(stats.elapsedMs)}`,
			});
			this.startStatusTimer();
			return;
		}

		this.stopStatusTimer();
		if (stats.status === 'ready') {
			const sourceLabel = stats.source === 'disk' ? 'cache' : 'rebuilt';
			this.indexStatusEl.createSpan({
				text: `Indexed ${stats.fileCount} notes · ${stats.chunkCount} chunks · ${stats.embeddingCount} embeddings · ${sourceLabel} · ${formatElapsed(stats.elapsedMs)}`,
			});
			return;
		}

		this.indexStatusEl.createSpan({ text: `Index not built · ${stats.fileCount} notes` });
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
