import { requestUrl } from 'obsidian';
import { NoteChunk } from './types';

export interface EmbeddingSettings {
	enabled: boolean;
	provider: 'ollama';
	endpoint: string;
	model: string;
	batchSize: number;
}

export interface ChunkEmbedding {
	chunkId: string;
	model: string;
	textHash: string;
	vector: number[];
}

interface OllamaEmbedResponse {
	embeddings?: number[][];
	embedding?: number[];
}

export function embeddingTextForChunk(chunk: NoteChunk): string {
	return [chunk.contextText, chunk.content].filter(Boolean).join('\n\n');
}

export async function embedTexts(settings: EmbeddingSettings, texts: string[]): Promise<number[][]> {
	if (!settings.enabled || texts.length === 0) {
		return [];
	}

	const response = await requestUrl({
		url: settings.endpoint,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: settings.model,
			input: texts,
		}),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Embedding HTTP ${response.status}: ${response.text.slice(0, 240)}`);
	}

	const data = response.json as OllamaEmbedResponse;
	if (Array.isArray(data.embeddings)) {
		return data.embeddings;
	}
	if (Array.isArray(data.embedding)) {
		return [data.embedding];
	}
	throw new Error('Embedding response did not contain embeddings.');
}

export function cosineSimilarity(left: number[], right: number[]): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	const length = Math.min(left.length, right.length);

	for (let index = 0; index < length; index += 1) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dot += leftValue * rightValue;
		leftNorm += leftValue * leftValue;
		rightNorm += rightValue * rightValue;
	}

	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function hashEmbeddingText(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}
