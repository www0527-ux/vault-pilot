import { requestUrl, TFile } from 'obsidian';
import { VaultPilotSettings } from '../settings';
import { SearchResult } from '../rag/types';

interface ChatClientOptions {
	settings: VaultPilotSettings;
	saveSettings: () => Promise<void>;
}

export async function refreshAvailableModels({ settings, saveSettings }: ChatClientOptions): Promise<string[]> {
	if (settings.provider === 'local') {
		settings.availableModels = [];
		settings.model = '';
		await saveSettings();
		return [];
	}

	const modelsEndpoint = settings.modelsEndpoint.trim();
	if (!modelsEndpoint) {
		throw new Error('Models endpoint is empty.');
	}
	if (!settings.apiKey.trim()) {
		throw new Error('API key is empty.');
	}

	const response = await requestUrl({
		url: modelsEndpoint,
		method: 'GET',
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${settings.apiKey.trim()}`,
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

	settings.availableModels = models;
	if (!settings.model || !models.includes(settings.model)) {
		settings.model = models[0] ?? '';
	}
	await saveSettings();
	return models;
}

export async function callRemoteModel(
	options: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
): Promise<string> {
	const { endpoint, body } = await buildChatRequest(options, question, results, activeFile, activeContent, false);

	const response = await requestUrl({
		url: endpoint,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${options.settings.apiKey.trim()}`,
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

export async function callRemoteModelStream(
	options: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
	onDelta: (delta: string) => void,
): Promise<string> {
	const { endpoint, body } = await buildChatRequest(options, question, results, activeFile, activeContent, true);
	const response = await window.fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${options.settings.apiKey.trim()}`,
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

async function buildChatRequest(
	{ settings, saveSettings }: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
	stream: boolean,
): Promise<{ endpoint: string; body: Record<string, unknown> }> {
	const endpoint = settings.endpoint.trim();
	let model = settings.model.trim();
	if (!endpoint) {
		throw new Error('Chat endpoint is empty.');
	}
	if (!model && settings.availableModels.length > 0) {
		model = settings.availableModels[0] ?? '';
		settings.model = model;
		await saveSettings();
	}
	if (!model) {
		throw new Error('No model selected. Refresh models or type a model id in settings.');
	}

	const context = results
		.map((result, index) => {
			const chunk = result.chunk;
			if (chunk) {
				return [
					`Source ${index + 1}: ${result.file.path}`,
					`Section: ${chunk.headingPath.join(' > ')}`,
					`Lines: ${chunk.startLine}-${chunk.endLine}`,
					chunk.contextText,
					'Content:',
					chunk.content,
				].join('\n');
			}
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
