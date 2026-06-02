/* eslint-disable obsidianmd/ui/sentence-case */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import VaultPilotPlugin from './main';

export type VaultPilotProvider = 'local' | 'deepseek' | 'custom';

export interface VaultPilotSettings {
	provider: VaultPilotProvider;
	endpoint: string;
	modelsEndpoint: string;
	apiKey: string;
	model: string;
	availableModels: string[];
	maxResults: number;
	includeCurrentNote: boolean;
}

export const PROVIDER_PRESETS: Record<
	Exclude<VaultPilotProvider, 'local'>,
	{ label: string; endpoint: string; modelsEndpoint: string; suggestedModels: string[] }
> = {
	deepseek: {
		label: 'DeepSeek',
		endpoint: 'https://api.deepseek.com/chat/completions',
		modelsEndpoint: 'https://api.deepseek.com/models',
		suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
	},
	custom: {
		label: 'Custom OpenAI-compatible',
		endpoint: '',
		modelsEndpoint: '',
		suggestedModels: [],
	},
};

export const DEFAULT_SETTINGS: VaultPilotSettings = {
	provider: 'local',
	endpoint: '',
	modelsEndpoint: '',
	apiKey: '',
	model: '',
	availableModels: [],
	maxResults: 5,
	includeCurrentNote: true,
};

export class VaultPilotSettingTab extends PluginSettingTab {
	plugin: VaultPilotPlugin;

	constructor(app: App, plugin: VaultPilotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Agent behavior').setHeading();

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Choose a local search mode or an OpenAI-compatible model provider.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('local', 'Local search')
					.addOption('deepseek', 'DeepSeek')
					.addOption('custom', 'Custom OpenAI-compatible')
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as VaultPilotProvider;
						if (value === 'deepseek') {
							this.applyPreset('deepseek');
						}
						if (value === 'local') {
							this.plugin.settings.model = '';
						}
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.provider !== 'local') {
			this.displayRemoteSettings(containerEl);
		}

		new Setting(containerEl)
			.setName('Maximum sources')
			.setDesc('How many notes VaultPilot should show and use for each answer.')
			.addSlider((slider) =>
				slider
					.setLimits(3, 12, 1)
					.setValue(this.plugin.settings.maxResults)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxResults = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Include current note')
			.setDesc('Use the active note as extra context when asking a question.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeCurrentNote).onChange(async (value) => {
					this.plugin.settings.includeCurrentNote = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	private displayRemoteSettings(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Chat endpoint')
			.setDesc('For DeepSeek, this should be https://api.deepseek.com/chat/completions.')
			.addText((text) =>
				text
					.setPlaceholder('https://api.example.com/chat/completions')
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.endpoint = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Models endpoint')
			.setDesc('Optional endpoint used to load selectable model names.')
			.addText((text) =>
				text
					.setPlaceholder('https://api.example.com/models')
					.setValue(this.plugin.settings.modelsEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.modelsEndpoint = value;
						await this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Refresh models').onClick(async () => {
					try {
						const models = await this.plugin.refreshAvailableModels();
						new Notice(`Loaded ${models.length} model${models.length === 1 ? '' : 's'}.`);
						this.display();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						new Notice(`Could not load models: ${message}`);
					}
				}),
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Stored locally in this plugin settings file.')
			.addText((text) =>
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		const models = this.getModelOptions();
		const modelSetting = new Setting(containerEl)
			.setName('Model')
			.setDesc('Choose a loaded model, or type one manually below for custom providers.');

		if (models.length > 0) {
			modelSetting.addDropdown((dropdown) => {
				for (const model of models) {
					dropdown.addOption(model, model);
				}
				if (this.plugin.settings.model && !models.includes(this.plugin.settings.model)) {
					dropdown.addOption(this.plugin.settings.model, `${this.plugin.settings.model} (current)`);
				}
				dropdown.setValue(this.plugin.settings.model || (models[0] ?? ''));
				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				});
			});
		}

		new Setting(containerEl)
			.setName('Manual model')
			.setDesc('Use this when your provider exposes a model that is not in the list.')
			.addText((text) =>
				text
					.setPlaceholder('model-id')
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	private applyPreset(provider: Exclude<VaultPilotProvider, 'local'>) {
		const preset = PROVIDER_PRESETS[provider];
		this.plugin.settings.endpoint = preset.endpoint;
		this.plugin.settings.modelsEndpoint = preset.modelsEndpoint;
		this.plugin.settings.availableModels = preset.suggestedModels;
		if (!preset.suggestedModels.includes(this.plugin.settings.model)) {
			this.plugin.settings.model = '';
		}
	}

	private getModelOptions(): string[] {
		const fromApi = this.plugin.settings.availableModels;
		if (fromApi.length > 0) {
			return fromApi;
		}
		if (this.plugin.settings.provider === 'deepseek') {
			return PROVIDER_PRESETS.deepseek.suggestedModels;
		}
		return [];
	}
}
