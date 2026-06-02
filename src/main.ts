/* eslint-disable obsidianmd/ui/sentence-case */
import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
	requestUrl,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	PROVIDER_PRESETS,
	VaultPilotSettingTab,
	VaultPilotSettings,
} from './settings';

const VIEW_TYPE_VAULTPILOT = 'vaultpilot-agent-view';

interface SearchResult {
	file: TFile;
	score: number;
	excerpt: string;
	matches: string[];
}

interface AgentAnswer {
	answer: string;
	results: SearchResult[];
	mode: 'local' | 'remote';
	warning?: string;
}

interface PreparedQuestion {
	activeFile: TFile | null;
	activeContent: string;
	results: SearchResult[];
}

export default class VaultPilotPlugin extends Plugin {
	settings!: VaultPilotSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_VAULTPILOT,
			(leaf) => new VaultPilotView(leaf, this),
		);

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
		const tokens = tokenize(query);
		if (tokens.length === 0) {
			return [];
		}

		const files = this.app.vault.getMarkdownFiles();
		const results = await Promise.all(
			files.map(async (file) => {
				const content = await this.app.vault.cachedRead(file);
				const score = scoreFile(file, content, tokens);
				if (score <= 0) {
					return null;
				}
				return {
					file,
					score,
					excerpt: createExcerpt(content, tokens),
					matches: topMatches(content, tokens),
				};
			}),
		);

		return results
			.filter((result): result is SearchResult => result !== null)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	async answerQuestion(question: string): Promise<AgentAnswer> {
		const { activeFile, activeContent, results } = await this.prepareQuestion(question);

		if (this.settings.provider !== 'local' && !this.settings.apiKey.trim()) {
			return {
				answer: [
					'当前选择了远程模型模式，但还没有配置 API key。',
					'请在 VaultPilot 设置里填入 API key，或者切回 Local search。',
					buildLocalAnswer(question, results, activeFile),
				].join('\n\n'),
				results,
				mode: 'local',
				warning: 'Missing API key',
			};
		}

		if (this.settings.provider !== 'local') {
			try {
				const answer = await this.callRemoteModel(question, results, activeFile, activeContent);
				return { answer, results, mode: 'remote' };
			} catch (error) {
				console.error(error);
				const message = error instanceof Error ? error.message : String(error);
				new Notice('VaultPilot remote model failed. Falling back to local mode.');
				return {
					answer: [
						`远程模型调用失败，已退回本地检索模式。`,
						`失败原因：${message}`,
						buildLocalAnswer(question, results, activeFile),
					].join('\n\n'),
					results,
					mode: 'local',
					warning: message,
				};
			}
		}

		return {
			answer: buildLocalAnswer(question, results, activeFile),
			results,
			mode: 'local',
		};
	}

	async streamAnswerQuestion(question: string, onDelta: (delta: string) => void): Promise<AgentAnswer> {
		const { activeFile, activeContent, results } = await this.prepareQuestion(question);

		if (this.settings.provider === 'local') {
			return {
				answer: buildLocalAnswer(question, results, activeFile),
				results,
				mode: 'local',
			};
		}

		if (!this.settings.apiKey.trim()) {
			return {
				answer: [
					'当前选择了远程模型模式，但还没有配置 API key。',
					'请在 VaultPilot 设置里填入 API key，或者切回 Local search。',
					buildLocalAnswer(question, results, activeFile),
				].join('\n\n'),
				results,
				mode: 'local',
				warning: 'Missing API key',
			};
		}

		try {
			const answer = await this.callRemoteModelStream(question, results, activeFile, activeContent, onDelta);
			return { answer, results, mode: 'remote' };
		} catch (error) {
			console.error(error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice('VaultPilot streaming failed. Falling back to normal response.');

			try {
				const answer = await this.callRemoteModel(question, results, activeFile, activeContent);
				return { answer, results, mode: 'remote', warning: message };
			} catch (fallbackError) {
				const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
				return {
					answer: [
						'远程模型调用失败，已退回本地检索模式。',
						`流式失败原因：${message}`,
						`普通请求失败原因：${fallbackMessage}`,
						buildLocalAnswer(question, results, activeFile),
					].join('\n\n'),
					results,
					mode: 'local',
					warning: fallbackMessage,
				};
			}
		}
	}

	async suggestLinks(file: TFile): Promise<SearchResult[]> {
		const content = await this.app.vault.cachedRead(file);
		const existingLinks = new Set(extractWikiLinks(content));
		const query = `${file.basename} ${extractHeadings(content).join(' ')} ${content.slice(0, 1200)}`;
		const results = await this.searchNotes(query, this.settings.maxResults + 5);

		return results
			.filter((result) => result.file.path !== file.path)
			.filter((result) => !existingLinks.has(result.file.basename) && !existingLinks.has(result.file.path))
			.slice(0, this.settings.maxResults);
	}

	async prepareQuestion(question: string): Promise<PreparedQuestion> {
		const activeFile = this.getActiveMarkdownFile();
		const activeContent =
			activeFile && this.settings.includeCurrentNote
				? await this.app.vault.cachedRead(activeFile)
				: '';
		const results = await this.searchNotes(
			activeContent ? `${question} ${activeFile?.basename ?? ''}` : question,
		);
		return { activeFile, activeContent, results };
	}

	async refreshAvailableModels(): Promise<string[]> {
		if (this.settings.provider === 'local') {
			this.settings.availableModels = [];
			this.settings.model = '';
			await this.saveSettings();
			return [];
		}

		const modelsEndpoint = this.settings.modelsEndpoint.trim();
		if (!modelsEndpoint) {
			throw new Error('Models endpoint is empty.');
		}
		if (!this.settings.apiKey.trim()) {
			throw new Error('API key is empty.');
		}

		const response = await requestUrl({
			url: modelsEndpoint,
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${this.settings.apiKey.trim()}`,
			},
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 240)}`);
		}

		const data = response.json as { data?: Array<{ id?: string }> };
		const models = (data.data ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);

		if (models.length === 0) {
			throw new Error('The models endpoint returned no model ids.');
		}

		this.settings.availableModels = models;
		if (!this.settings.model || !models.includes(this.settings.model)) {
			this.settings.model = models[0] ?? '';
		}
		await this.saveSettings();
		return models;
	}

	async callRemoteModel(
		question: string,
		results: SearchResult[],
		activeFile: TFile | null,
		activeContent: string,
	): Promise<string> {
		const { endpoint, body } = await this.buildChatRequest(question, results, activeFile, activeContent, false);

		const response = await requestUrl({
			url: endpoint,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.settings.apiKey.trim()}`,
			},
			body: JSON.stringify(body),
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 240)}`);
		}

		const data = response.json as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const content = data.choices?.[0]?.message?.content?.trim();
		if (!content) {
			throw new Error('模型返回为空，或响应格式不是 OpenAI-compatible chat completions。');
		}
		return content;
	}

	async callRemoteModelStream(
		question: string,
		results: SearchResult[],
		activeFile: TFile | null,
		activeContent: string,
		onDelta: (delta: string) => void,
	): Promise<string> {
		const { endpoint, body } = await this.buildChatRequest(question, results, activeFile, activeContent, true);
		const response = await window.fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.settings.apiKey.trim()}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
		}
		if (!response.body) {
			throw new Error('Streaming response body is empty.');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let answer = '';

		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split(/\r?\n\r?\n/);
			buffer = parts.pop() ?? '';

			for (const part of parts) {
				const delta = parseStreamPart(part);
				if (!delta) {
					continue;
				}
				if (delta.done) {
					return answer;
				}
				answer += delta.content;
				onDelta(delta.content);
			}
		}

		return answer;
	}

	async buildChatRequest(
		question: string,
		results: SearchResult[],
		activeFile: TFile | null,
		activeContent: string,
		stream: boolean,
	): Promise<{ endpoint: string; body: Record<string, unknown> }> {
		const endpoint = this.settings.endpoint.trim();
		let model = this.settings.model.trim();
		if (!endpoint) {
			throw new Error('Chat endpoint is empty.');
		}
		if (!model && this.settings.availableModels.length > 0) {
			model = this.settings.availableModels[0] ?? '';
			this.settings.model = model;
			await this.saveSettings();
		}
		if (!model) {
			throw new Error('No model selected. Refresh models or type a model id in settings.');
		}

		const context = results
			.map((result, index) => {
				return `Source ${index + 1}: ${result.file.path}\n${result.excerpt}`;
			})
			.join('\n\n');
		const current = activeFile ? `Current note: ${activeFile.path}\n${activeContent.slice(0, 2000)}` : '';
		const prompt = [
			'You are VaultPilot, an Obsidian knowledge agent.',
			'Answer using only the supplied notes. Cite note paths in square brackets.',
			'If the notes are insufficient, say what is missing and suggest what to search next.',
			current,
			`Question: ${question}`,
			`Retrieved notes:\n${context}`,
		]
			.filter(Boolean)
			.join('\n\n');

		return {
			endpoint,
			body: {
				model,
				messages: [{ role: 'user', content: prompt }],
				temperature: 0.2,
				stream,
			},
		};
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

	private getVaultPilotView(): VaultPilotView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULTPILOT)[0];
		const view = leaf?.view;
		return view instanceof VaultPilotView ? view : null;
	}

	private normalizeSettings() {
		const legacyProvider = this.settings.provider as string;
		if (legacyProvider === 'openai-compatible') {
			this.settings.provider = this.settings.endpoint.includes('api.deepseek.com') ? 'deepseek' : 'custom';
		}
		if (!Array.isArray(this.settings.availableModels)) {
			this.settings.availableModels = [];
		}
		if (!this.settings.modelsEndpoint) {
			if (this.settings.provider === 'deepseek') {
				this.settings.modelsEndpoint = PROVIDER_PRESETS.deepseek.modelsEndpoint;
			} else {
				this.settings.modelsEndpoint = '';
			}
		}
		if (this.settings.provider === 'deepseek') {
			this.settings.endpoint = PROVIDER_PRESETS.deepseek.endpoint;
			if (this.settings.availableModels.length === 0) {
				this.settings.availableModels = PROVIDER_PRESETS.deepseek.suggestedModels;
			}
		}
	}
}

class VaultPilotView extends ItemView {
	private plugin: VaultPilotPlugin;
	private inputEl!: HTMLTextAreaElement;
	private messagesEl!: HTMLElement;

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

	async ask(question: string) {
		this.inputEl.value = '';
		this.addMessage('user', question);
		const loading = this.addMessage('assistant', 'Thinking through your vault...');

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
		const loading = this.addMessage('assistant', 'Looking for related notes...');
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
	}

	private scrollMessagesToBottom() {
		const viewWindow = this.containerEl.ownerDocument.defaultView ?? window;
		viewWindow.requestAnimationFrame(() => {
			this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
		});
	}
}

function tokenize(input: string): string[] {
	const tokens = new Set<string>();
	const segments = input
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);

	for (const segment of segments) {
		tokens.add(segment);
		if (/[\u3400-\u9fff]/u.test(segment)) {
			const chars = Array.from(segment);
			for (let index = 0; index < chars.length - 1; index += 1) {
				const first = chars[index];
				const second = chars[index + 1];
				if (first && second) {
					tokens.add(`${first}${second}`);
				}
			}
		}
	}

	return Array.from(tokens).slice(0, 60);
}

function scoreFile(file: TFile, content: string, tokens: string[]): number {
	const lowerName = file.basename.toLowerCase();
	const lowerPath = file.path.toLowerCase();
	const lowerContent = content.toLowerCase();
	let score = 0;

	for (const token of tokens) {
		if (lowerName.includes(token)) {
			score += 8;
		}
		if (lowerPath.includes(token)) {
			score += 4;
		}
		const count = countOccurrences(lowerContent, token);
		score += Math.min(count, 8);
	}

	score += extractHeadings(content).some((heading) => tokens.some((token) => heading.toLowerCase().includes(token)))
		? 4
		: 0;
	return score;
}

function countOccurrences(content: string, token: string): number {
	let count = 0;
	let index = content.indexOf(token);
	while (index !== -1) {
		count += 1;
		index = content.indexOf(token, index + token.length);
	}
	return count;
}

function createExcerpt(content: string, tokens: string[]): string {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const line =
		lines.find((candidate) => tokens.some((token) => candidate.toLowerCase().includes(token))) ??
		lines[0] ??
		'';
	return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function topMatches(content: string, tokens: string[]): string[] {
	const lowerContent = content.toLowerCase();
	return tokens.filter((token) => lowerContent.includes(token)).slice(0, 5);
}

function extractHeadings(content: string): string[] {
	return content
		.split(/\r?\n/)
		.filter((line) => line.startsWith('#'))
		.map((line) => line.replace(/^#+\s*/, '').trim())
		.filter(Boolean);
}

function extractWikiLinks(content: string): string[] {
	const links = new Set<string>();
	for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
		const target = match[1]?.trim();
		if (target) {
			links.add(target);
		}
	}
	return Array.from(links);
}

function parseStreamPart(part: string): { done: true } | { done: false; content: string } | null {
	const lines = part
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith('data:'));

	for (const line of lines) {
		const payload = line.replace(/^data:\s*/, '');
		if (!payload) {
			continue;
		}
		if (payload === '[DONE]') {
			return { done: true };
		}

		try {
			const data = JSON.parse(payload) as {
				choices?: Array<{
					delta?: {
						content?: string | null;
						reasoning_content?: string | null;
					};
				}>;
			};
			const delta = data.choices?.[0]?.delta;
			const content = delta?.content ?? delta?.reasoning_content ?? null;
			return content ? { done: false, content } : null;
		} catch (error) {
			console.error(error);
			return null;
		}
	}

	return null;
}

function buildLocalAnswer(question: string, results: SearchResult[], activeFile: TFile | null): string {
	if (results.length === 0) {
		return [
			'本地检索没有找到足够相关的笔记。',
			activeFile ? `当前笔记：[[${activeFile.basename}]]。` : '',
			'可以换成更具体的概念、标签、文件名或标题再问一次。',
		]
			.filter(Boolean)
			.join('\n');
	}

	const sources = results
		.slice(0, 5)
		.map((result, index) => `${index + 1}. [[${result.file.basename}]] - ${result.excerpt}`)
		.join('\n');

	return [
		`当前是本地检索结果，还不是大模型回答。检索问题：${question}`,
		'最相关的笔记：',
		sources,
		'下一步建议：如果你已经配置 DeepSeek，请确认 Answer mode 是 OpenAI-compatible；如果远程调用失败，VaultPilot 会在这里显示失败原因。',
	].join('\n\n');
}
