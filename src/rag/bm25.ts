import { NoteChunk, SearchResult } from './types';
import { tokenize } from './text';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const HEADING_BOOST = 1.6;
const FILE_BOOST = 1.2;

interface IndexedChunk {
	chunk: NoteChunk;
	tokens: string[];
	termFrequency: Map<string, number>;
	length: number;
	headingTokens: Set<string>;
	fileTokens: Set<string>;
}

export interface Bm25Index {
	chunks: IndexedChunk[];
	documentFrequency: Map<string, number>; // token -> number of chunks containing the token
	invertedIndex: Map<string, Set<number>>; // token -> matching chunk indexes
	averageLength: number;
}

export function searchChunksWithBm25(chunks: NoteChunk[], queryTokens: string[], limit: number): SearchResult[] {
	if (chunks.length === 0 || queryTokens.length === 0) {
		return [];
	}

	const index = buildBm25Index(chunks);
	return searchBm25Index(index, queryTokens, limit);
}

export function searchBm25Index(index: Bm25Index, queryTokens: string[], limit: number): SearchResult[] {
	if (index.chunks.length === 0 || queryTokens.length === 0) {
		return [];
	}

	const candidates = getCandidateChunks(index, queryTokens);
	return candidates
		.map((indexedChunk) => scoreIndexedChunk(index, indexedChunk, queryTokens))
		.filter((result): result is SearchResult => result !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

// Prepare the data for BM25 search by tokenizing chunks and calculating reusable corpus statistics.
export function buildBm25Index(chunks: NoteChunk[]): Bm25Index {
	const indexedChunks = chunks.map((chunk) => {
		const tokens = tokenize(chunkSearchText(chunk));
		const termFrequency = new Map<string, number>();
		for (const token of tokens) {
			termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
		}
		return {
			chunk,
			tokens,
			termFrequency,
			length: tokens.length,
			headingTokens: new Set(tokenize(chunk.headingPath.join(' '))),
			fileTokens: new Set(tokenize(`${chunk.file.basename} ${chunk.file.path}`)),
		};
	});

	const documentFrequency = new Map<string, number>();
	const invertedIndex = new Map<string, Set<number>>();
	for (let chunkIndex = 0; chunkIndex < indexedChunks.length; chunkIndex += 1) {
		const indexedChunk = indexedChunks[chunkIndex];
		if (!indexedChunk) {
			continue;
		}
		for (const token of new Set(indexedChunk.tokens)) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
			const postings = invertedIndex.get(token) ?? new Set<number>();
			postings.add(chunkIndex);
			invertedIndex.set(token, postings);
		}
	}

	const averageLength =
		indexedChunks.reduce((total, chunk) => total + chunk.length, 0) / indexedChunks.length;

	return { chunks: indexedChunks, documentFrequency, invertedIndex, averageLength };
}

function getCandidateChunks(index: Bm25Index, queryTokens: string[]): IndexedChunk[] {
	const candidateIndexes = new Set<number>();
	for (const token of new Set(queryTokens)) {
		const postings = index.invertedIndex.get(token);
		if (!postings) {
			continue;
		}
		for (const chunkIndex of postings) {
			candidateIndexes.add(chunkIndex);
		}
	}

	return Array.from(candidateIndexes)
		.map((chunkIndex) => index.chunks[chunkIndex])
		.filter((chunk): chunk is IndexedChunk => chunk !== undefined);
}

function scoreIndexedChunk(
	index: Bm25Index,
	indexedChunk: IndexedChunk,
	queryTokens: string[],
): SearchResult | null {
	let score = 0;
	const matchedTokens: string[] = [];
	const uniqueQueryTokens = Array.from(new Set(queryTokens));

	for (const token of uniqueQueryTokens) {
		const frequency = indexedChunk.termFrequency.get(token) ?? 0;
		const headingHit = indexedChunk.headingTokens.has(token);
		const fileHit = indexedChunk.fileTokens.has(token);

		if (frequency <= 0 && !headingHit && !fileHit) {
			continue;
		}

		const idf = inverseDocumentFrequency(
			index.chunks.length,
			index.documentFrequency.get(token) ?? 0,
		);
		const bm25 = frequency > 0 ? bm25TermScore(frequency, indexedChunk.length, index.averageLength) : 0;
		const boost = (headingHit ? HEADING_BOOST : 1) * (fileHit ? FILE_BOOST : 1);
		score += idf * (bm25 * boost + (headingHit ? 0.6 : 0) + (fileHit ? 0.2 : 0));
		matchedTokens.push(token);
	}

	if (score <= 0) {
		return null;
	}

	return {
		file: indexedChunk.chunk.file,
		score: roundScore(score),
		excerpt: createExcerpt(indexedChunk.chunk.content, matchedTokens),
		matches: matchedTokens.slice(0, 8),
		chunk: indexedChunk.chunk,
	};
}

function chunkSearchText(chunk: NoteChunk): string {
	return [
		chunk.file.basename,
		chunk.file.path,
		chunk.headingPath.join(' '),
		chunk.contextText,
		chunk.content,
	].join('\n');
}

function inverseDocumentFrequency(totalDocuments: number, documentFrequency: number): number {
	return Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25TermScore(frequency: number, documentLength: number, averageLength: number): number {
	const denominator =
		frequency + BM25_K1 * (1 - BM25_B + BM25_B * (documentLength / averageLength));
	return (frequency * (BM25_K1 + 1)) / denominator;
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

function roundScore(score: number): number {
	return Math.round(score * 100) / 100;
}
