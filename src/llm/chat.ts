import { requestUrl, TFile } from 'obsidian';
import { VaultPilotSettings } from '../settings';
import { normalizeRemoteRewrite } from '../rag/query-rewrite';
import { QueryRewrite, SearchResult } from '../rag/types';

export interface ChatClientOptions {
	settings: VaultPilotSettings;
	saveSettings: () => Promise<void>;
}

export interface RemoteModelAnswer {
	answer: string;
	reasoning: string;
}

export type RemoteStreamEvent =
	| { type: 'answer'; delta: string }
	| { type: 'process'; delta: string };

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

export async function rewriteRetrievalQuery(
	options: ChatClientOptions,
	question: string,
	activeFile: TFile | null,
	activeContent: string,
): Promise<QueryRewrite> {
	const { endpoint, model } = await resolveChatTarget(options);
	const currentNoteHint = activeFile
		? [
				`Current note path: ${activeFile.path}`,
				`Current note excerpt: ${activeContent.slice(0, 1200)}`,
			].join('\n')
		: 'No active note context.';
	const prompt = [
		'You are a retrieval query rewriter for an Obsidian vault assistant.',
		'Rewrite the user question into several search queries for Markdown notes.',
		'Return only valid JSON with keys: rewrittenQuery, queries, keywords, confidence.',
		'queries must contain 3-6 distinct retrieval queries. Keep the original entity, add title/path variants, and add semantic variants.',
		'Do not answer the question. Do not invent citations. Do not claim terms were found in the vault.',
		'Use concise Chinese and English aliases when helpful.',
		'If the query contains a Chinese person/place/organization name, add likely pinyin and spaced romanization variants.',
		'For title/path matching, include plausible hyphenated variants when useful.',
		currentNoteHint,
		`User question: ${question}`,
	].join('\n\n');

	const response = await requestUrl({
		url: endpoint,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${options.settings.apiKey.trim()}`,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			temperature: 0,
			stream: false,
		}),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Query rewrite HTTP ${response.status}: ${response.text.slice(0, 240)}`);
	}

	const data = response.json as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = data.choices?.[0]?.message?.content?.trim();
	if (!content) {
		throw new Error('Query rewrite returned empty content.');
	}

	const rewrite = normalizeRemoteRewrite(question, parseJsonObject(content));
	if (!rewrite) {
		throw new Error('Query rewrite response did not include rewrittenQuery.');
	}
	return rewrite;
}

export async function callRemoteModel(
	options: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
): Promise<RemoteModelAnswer> {
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
		choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
	};
	const content = data.choices?.[0]?.message?.content?.trim();
	if (!content) {
		throw new Error('The model returned empty content or a non-compatible chat completions response.');
	}
	return {
		answer: content,
		reasoning: data.choices?.[0]?.message?.reasoning_content?.trim() ?? '',
	};
}

export async function callRemoteModelStream(
	options: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
	onEvent: (event: RemoteStreamEvent) => void,
): Promise<RemoteModelAnswer> {
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
	let reasoning = '';

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
				return { answer, reasoning };
			}
			if (delta.kind === 'reasoning') {
				reasoning += delta.content;
				onEvent({ type: 'process', delta: delta.content });
				continue;
			}
			answer += delta.content;
			onEvent({ type: 'answer', delta: delta.content });
		}
	}

	return { answer, reasoning };
}

async function buildChatRequest(
	options: ChatClientOptions,
	question: string,
	results: SearchResult[],
	activeFile: TFile | null,
	activeContent: string,
	stream: boolean,
): Promise<{ endpoint: string; body: Record<string, unknown> }> {
	const { endpoint, model } = await resolveChatTarget(options);

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
		'Put no planning, analysis, source-selection narrative, or hidden reasoning in the final answer.',
		'Start directly with the answer. Do not write phrases like "I will answer based on the notes" or "The provided notes include".',
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

async function resolveChatTarget({ settings, saveSettings }: ChatClientOptions): Promise<{ endpoint: string; model: string }> {
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
	return { endpoint, model };
}

function parseJsonObject(content: string): Record<string, unknown> {
	const trimmed = content.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
	const jsonText = fenced?.[1] ?? trimmed;
	try {
		return JSON.parse(jsonText) as Record<string, unknown>;
	} catch {
		const start = jsonText.indexOf('{');
		const end = jsonText.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
		}
		throw new Error('Query rewrite response was not valid JSON.');
	}
}

function parseStreamPart(
	part: string,
): { done: true } | { done: false; kind: 'content' | 'reasoning'; content: string } | null {
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
			if (delta?.reasoning_content) {
				return { done: false, kind: 'reasoning', content: delta.reasoning_content };
			}
			if (delta?.content) {
				return { done: false, kind: 'content', content: delta.content };
			}
			return null;
		} catch (error) {
			console.error(error);
			return null;
		}
	}

	return null;
}
