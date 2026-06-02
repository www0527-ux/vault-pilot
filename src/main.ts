/* eslint-disable obsidianmd/ui/sentence-case */
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
	callRemoteModel,
	callRemoteModelStream,
	refreshAvailableModels,
} from './llm/chat';
import { buildLocalAnswer } from './rag/local-answer';
import { searchNotes, suggestLinks } from './rag/search';
import { AgentAnswer, PreparedQuestion, SearchResult } from './rag/types';
import {
	DEFAULT_SETTINGS,
	PROVIDER_PRESETS,
	VaultPilotSettingTab,
	VaultPilotSettings,
} from './settings';
import { VaultPilotView, VIEW_TYPE_VAULTPILOT } from './ui/view';

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
		return searchNotes(this.app.vault, query, limit);
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
				const answer = await callRemoteModel(
					this.getChatClientOptions(),
					question,
					results,
					activeFile,
					activeContent,
				);
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
			const answer = await callRemoteModelStream(
				this.getChatClientOptions(),
				question,
				results,
				activeFile,
				activeContent,
				onDelta,
			);
			return { answer, results, mode: 'remote' };
		} catch (error) {
			console.error(error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice('VaultPilot streaming failed. Falling back to normal response.');

			try {
				const answer = await callRemoteModel(
					this.getChatClientOptions(),
					question,
					results,
					activeFile,
					activeContent,
				);
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
		return suggestLinks(
			this.app.vault,
			file,
			this.settings.maxResults,
			(query, limit) => this.searchNotes(query, limit),
		);
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
