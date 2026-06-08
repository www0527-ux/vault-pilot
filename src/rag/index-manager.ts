import { TFile, Vault } from 'obsidian';
import { Bm25Index, buildBm25Index, searchBm25Index } from './bm25';
import { chunkMarkdownNote } from './chunker';
import {
	ChunkEmbedding,
	EmbeddingSettings,
	cosineSimilarity,
	embedTexts,
	embeddingTextForChunk,
	hashEmbeddingText,
} from './embeddings';
import { FolderInspection, FolderInspectionOptions, NoteChunk, SearchResult } from './types';
import { tokenize } from './text';

const CACHE_VERSION = 2;
const CACHE_DIR = 'vaultpilot';
const CACHE_FILE_NAME = `${CACHE_DIR}/index-cache.json`;
const EMBEDDING_CANDIDATE_LIMIT = 30;
const BM25_WEIGHT = 0.3;
const EMBEDDING_WEIGHT = 0.7;
const MIN_RELEVANT_SCORE = 0.35;
const MIN_RELATIVE_RELEVANCE = 0.4;
const MIN_MULTI_QUERY_RELEVANT_SCORE = 0.28;
const EXCLUDED_MARKDOWN_PATH_PREFIXES = ['_rag_eval/'];
const DEFAULT_FOLDER_MAX_FILES = 60;
const DEFAULT_FOLDER_MAX_HEADINGS_PER_FILE = 8;
const DEFAULT_FOLDER_MAX_EXCERPTS_PER_FILE = 2;

export interface IndexStats {
	status: 'empty' | 'loading' | 'building' | 'ready';
	fileCount: number;
	chunkCount: number;
	embeddingCount: number;
	lastBuiltAt: number | null;
	elapsedMs: number;
	source: 'none' | 'memory' | 'disk' | 'rebuilt';
}

interface CachedSearchIndex {
	signature: string;
	chunks: NoteChunk[];
	bm25Index: Bm25Index;
	embeddings: Map<string, ChunkEmbedding>;
	stats: IndexStats;
}

interface SerializedChunk {
	id: string;
	filePath: string;
	title: string;
	headingPath: string[];
	content: string;
	contextText: string;
	startLine: number;
	endLine: number;
}

interface SerializedIndexCache {
	version: number;
	signature: string;
	builtAt: number;
	files: Array<{
		path: string;
		size: number;
		mtime: number;
	}>;
	chunks: SerializedChunk[];
	embeddings?: ChunkEmbedding[];
}

type IndexListener = (stats: IndexStats) => void;

export class IndexManager {
	private vault: Vault;
	private embeddingSettings: () => EmbeddingSettings;
	private cachePath: string;
	private cachedIndex: CachedSearchIndex | null = null;
	private listeners = new Set<IndexListener>();
	private buildStartedAt: number | null = null;
	private loadStartedAt: number | null = null;

	constructor(vault: Vault, embeddingSettings: () => EmbeddingSettings) {
		this.vault = vault;
		this.embeddingSettings = embeddingSettings;
		this.cachePath = `${vault.configDir}/${CACHE_FILE_NAME}`;
	}

	onChange(listener: IndexListener): () => void {
		this.listeners.add(listener);
		listener(this.getStats());
		return () => {
			this.listeners.delete(listener);
		};
	}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const tokens = tokenize(query);
		if (tokens.length === 0) {
			return [];
		}

		const index = await this.getIndex();
		return this.searchHybrid(index, query, tokens, limit);
	}

	async searchMany(queries: string[], limit: number): Promise<SearchResult[]> {
		const normalizedQueries = Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)));
		if (normalizedQueries.length === 0) {
			return [];
		}

		const index = await this.getIndex();
		const merged = new Map<string, SearchResult & { retrievalScore: number; queryHits: number }>();
		for (const query of normalizedQueries) {
			const tokens = tokenize(query);
			if (tokens.length === 0) {
				continue;
			}
			const results = await this.searchHybrid(index, query, tokens, EMBEDDING_CANDIDATE_LIMIT);
			for (const result of results) {
				const key = result.chunk?.id ?? result.file.path;
				const existing = merged.get(key);
				if (existing) {
					existing.retrievalScore = Math.max(existing.retrievalScore, result.score);
					existing.queryHits += 1;
					existing.matches = Array.from(new Set([...existing.matches, ...result.matches])).slice(0, 10);
					continue;
				}
				merged.set(key, {
					...result,
					retrievalScore: result.score,
					queryHits: 1,
				});
			}
		}

		const rankedResults = Array.from(merged.values())
			.map((result) => ({
				...result,
				score: roundScore(rerankScore(result, normalizedQueries)),
			}))
			.sort((a, b) => b.score - a.score);

		return pruneWeakResults(rankedResults, limit);
	}

	async inspectFolder(options: FolderInspectionOptions): Promise<FolderInspection> {
		const index = await this.getIndex();
		const folderPath = normalizeFolderPath(options.path);
		const maxFiles = clampPositiveInteger(options.maxFiles, DEFAULT_FOLDER_MAX_FILES, 200);
		const maxHeadingsPerFile = clampPositiveInteger(
			options.maxHeadingsPerFile,
			DEFAULT_FOLDER_MAX_HEADINGS_PER_FILE,
			20,
		);
		const maxExcerptsPerFile = clampPositiveInteger(
			options.maxExcerptsPerFile,
			DEFAULT_FOLDER_MAX_EXCERPTS_PER_FILE,
			5,
		);

		const chunks = index.chunks.filter((chunk) => isChunkInFolder(chunk, folderPath));
		const files = buildFolderFileSummaries(chunks, maxHeadingsPerFile, maxExcerptsPerFile);
		const sortedFiles = files.sort((a, b) => {
			if (b.chunkCount !== a.chunkCount) {
				return b.chunkCount - a.chunkCount;
			}
			return a.path.localeCompare(b.path);
		});

		return {
			path: folderPath,
			fileCount: files.length,
			chunkCount: chunks.length,
			returnedFileCount: Math.min(sortedFiles.length, maxFiles),
			truncated: sortedFiles.length > maxFiles,
			topSubfolders: topSubfolders(files.map((file) => file.path), folderPath),
			topHeadings: topHeadings(chunks),
			files: sortedFiles.slice(0, maxFiles),
		};
	}

	async ensureReady(): Promise<IndexStats> {
		await this.getIndex();
		return this.getStats();
	}

	async clear() {
		this.cachedIndex = null;
		this.buildStartedAt = null;
		this.loadStartedAt = null;
		try {
			await this.vault.adapter.remove(this.cachePath);
		} catch (error) {
			console.debug('VaultPilot index cache was already empty.', error);
		}
		this.emit();
	}

	async rebuild(): Promise<IndexStats> {
		this.cachedIndex = null;
		await this.getIndex();
		return this.getStats();
	}

	getStats(): IndexStats {
		if (this.loadStartedAt !== null) {
			return {
				status: 'loading',
				fileCount: getSearchableMarkdownFiles(this.vault).length,
				chunkCount: this.cachedIndex?.stats.chunkCount ?? 0,
				embeddingCount: this.cachedIndex?.stats.embeddingCount ?? 0,
				lastBuiltAt: this.cachedIndex?.stats.lastBuiltAt ?? null,
				elapsedMs: Date.now() - this.loadStartedAt,
				source: 'disk',
			};
		}

		if (this.buildStartedAt !== null) {
			return {
				status: 'building',
				fileCount: this.cachedIndex?.stats.fileCount ?? getSearchableMarkdownFiles(this.vault).length,
				chunkCount: this.cachedIndex?.stats.chunkCount ?? 0,
				embeddingCount: this.cachedIndex?.stats.embeddingCount ?? 0,
				lastBuiltAt: this.cachedIndex?.stats.lastBuiltAt ?? null,
				elapsedMs: Date.now() - this.buildStartedAt,
				source: 'rebuilt',
			};
		}

		if (!this.cachedIndex) {
			return {
				status: 'empty',
				fileCount: getSearchableMarkdownFiles(this.vault).length,
				chunkCount: 0,
				embeddingCount: 0,
				lastBuiltAt: null,
				elapsedMs: 0,
				source: 'none',
			};
		}

		return this.cachedIndex.stats;
	}

	private async getIndex(): Promise<CachedSearchIndex> {
		const files = getSearchableMarkdownFiles(this.vault);
		const signature = buildVaultSignature(files);
		if (this.cachedIndex?.signature === signature) {
			return this.cachedIndex;
		}

		const restored = await this.tryRestoreFromDisk(files, signature);
		if (restored) {
			return restored;
		}
		const reusableEmbeddings = await this.readReusableEmbeddingsFromDisk();

		this.buildStartedAt = Date.now();
		this.emit();

		const chunks = (
			await Promise.all(
				files.map(async (file) => {
					const content = await this.vault.cachedRead(file);
					return chunkMarkdownNote(file, content);
				}),
			)
		).flat();

		const embeddings = await this.buildEmbeddings(chunks, reusableEmbeddings);
		const elapsedMs = this.buildStartedAt === null ? 0 : Date.now() - this.buildStartedAt;
		this.cachedIndex = {
			signature,
			chunks,
			bm25Index: buildBm25Index(chunks),
			embeddings,
			stats: {
				status: 'ready',
				fileCount: files.length,
				chunkCount: chunks.length,
				embeddingCount: embeddings.size,
				lastBuiltAt: Date.now(),
				elapsedMs,
				source: 'rebuilt',
			},
		};
		this.buildStartedAt = null;
		await this.writeToDisk(files, signature, chunks, embeddings, this.cachedIndex.stats.lastBuiltAt ?? Date.now());
		this.emit();
		return this.cachedIndex;
	}

	private async tryRestoreFromDisk(files: TFile[], signature: string): Promise<CachedSearchIndex | null> {
		this.loadStartedAt = Date.now();
		this.emit();

		try {
			if (!(await this.vault.adapter.exists(this.cachePath))) {
				return null;
			}

			const raw = await this.vault.adapter.read(this.cachePath);
			const cache = JSON.parse(raw) as SerializedIndexCache;
			if (cache.version !== CACHE_VERSION || cache.signature !== signature) {
				return null;
			}

			const filesByPath = new Map(files.map((file) => [file.path, file]));
			const chunks = cache.chunks
				.map((chunk) => deserializeChunk(chunk, filesByPath))
				.filter((chunk): chunk is NoteChunk => chunk !== null);
			if (chunks.length !== cache.chunks.length) {
				return null;
			}
			const cachedEmbeddings = new Map((cache.embeddings ?? []).map((embedding) => [embedding.chunkId, embedding]));
			const embeddings = await this.buildEmbeddings(chunks, cachedEmbeddings);

			this.cachedIndex = {
				signature,
				chunks,
				bm25Index: buildBm25Index(chunks),
				embeddings,
				stats: {
					status: 'ready',
					fileCount: files.length,
					chunkCount: chunks.length,
					embeddingCount: embeddings.size,
					lastBuiltAt: cache.builtAt,
					elapsedMs: Date.now() - this.loadStartedAt,
					source: 'disk',
				},
			};
			if (embeddings.size !== cachedEmbeddings.size) {
				await this.writeToDisk(files, signature, chunks, embeddings, cache.builtAt);
			}
			return this.cachedIndex;
		} catch (error) {
			console.debug('VaultPilot could not restore index cache.', error);
			return null;
		} finally {
			this.loadStartedAt = null;
			this.emit();
		}
	}

	private async readReusableEmbeddingsFromDisk(): Promise<Map<string, ChunkEmbedding>> {
		try {
			if (!(await this.vault.adapter.exists(this.cachePath))) {
				return new Map();
			}
			const raw = await this.vault.adapter.read(this.cachePath);
			const cache = JSON.parse(raw) as SerializedIndexCache;
			if (cache.version !== CACHE_VERSION) {
				return new Map();
			}
			return new Map((cache.embeddings ?? []).map((embedding) => [embedding.chunkId, embedding]));
		} catch (error) {
			console.debug('VaultPilot could not reuse cached embeddings.', error);
			return new Map();
		}
	}

	private async writeToDisk(
		files: TFile[],
		signature: string,
		chunks: NoteChunk[],
		embeddings: Map<string, ChunkEmbedding>,
		builtAt: number,
	) {
		const cache: SerializedIndexCache = {
			version: CACHE_VERSION,
			signature,
			builtAt,
			files: files.map((file) => ({
				path: file.path,
				size: file.stat.size,
				mtime: file.stat.mtime,
			})),
			chunks: chunks.map(serializeChunk),
			embeddings: Array.from(embeddings.values()),
		};
		await this.ensureCacheDirectory();
		await this.vault.adapter.write(this.cachePath, JSON.stringify(cache));
	}

	private async buildEmbeddings(
		chunks: NoteChunk[],
		cachedEmbeddings: Map<string, ChunkEmbedding>,
	): Promise<Map<string, ChunkEmbedding>> {
		const settings = this.embeddingSettings();
		if (!settings.enabled) {
			return new Map();
		}

		const embeddings = new Map<string, ChunkEmbedding>();
		const missingChunks: NoteChunk[] = [];
		for (const chunk of chunks) {
			const textHash = hashEmbeddingText(embeddingTextForChunk(chunk));
			const cached = cachedEmbeddings.get(chunk.id);
			if (cached && cached.model === settings.model && cached.textHash === textHash) {
				embeddings.set(chunk.id, cached);
				continue;
			}
			missingChunks.push(chunk);
		}

		for (let index = 0; index < missingChunks.length; index += settings.batchSize) {
			const batch = missingChunks.slice(index, index + settings.batchSize);
			try {
				const vectors = await embedTexts(settings, batch.map(embeddingTextForChunk));
				for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
					const chunk = batch[batchIndex];
					const vector = vectors[batchIndex];
					if (!chunk || !vector) {
						continue;
					}
					embeddings.set(chunk.id, {
						chunkId: chunk.id,
						model: settings.model,
						textHash: hashEmbeddingText(embeddingTextForChunk(chunk)),
						vector,
					});
				}
			} catch (error) {
				console.debug('VaultPilot embedding generation failed. Falling back to BM25 only.', error);
				return embeddings;
			}
		}

		return embeddings;
	}

	private async searchHybrid(
		index: CachedSearchIndex,
		query: string,
		tokens: string[],
		limit: number,
	): Promise<SearchResult[]> {
		const bm25Results = searchBm25Index(index.bm25Index, tokens, EMBEDDING_CANDIDATE_LIMIT);
		const embeddingResults = await this.searchEmbeddings(index, query, EMBEDDING_CANDIDATE_LIMIT);
		if (embeddingResults.length === 0) {
			return bm25Results.slice(0, limit);
		}

		const merged = new Map<string, SearchResult & { bm25Score?: number; embeddingScore?: number }>();
		const maxBm25 = Math.max(...bm25Results.map((result) => result.score), 0);
		const maxEmbedding = Math.max(...embeddingResults.map((result) => result.score), 0);

		for (const result of bm25Results) {
			const key = result.chunk?.id ?? result.file.path;
			merged.set(key, {
				...result,
				bm25Score: maxBm25 > 0 ? result.score / maxBm25 : 0,
				embeddingScore: 0,
			});
		}

		for (const result of embeddingResults) {
			const key = result.chunk?.id ?? result.file.path;
			const existing = merged.get(key);
			const embeddingScore = maxEmbedding > 0 ? result.score / maxEmbedding : 0;
			if (existing) {
				existing.embeddingScore = embeddingScore;
				existing.matches = Array.from(new Set([...existing.matches, ...result.matches])).slice(0, 8);
				continue;
			}
			merged.set(key, {
				...result,
				bm25Score: 0,
				embeddingScore,
			});
		}

		return Array.from(merged.values())
			.map((result) => ({
				...result,
				score: roundScore((result.bm25Score ?? 0) * BM25_WEIGHT + (result.embeddingScore ?? 0) * EMBEDDING_WEIGHT),
			}))
			.filter((result) => bm25Results.length === 0 || hasLexicalEvidence(result))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	private async searchEmbeddings(
		index: CachedSearchIndex,
		query: string,
		limit: number,
	): Promise<SearchResult[]> {
		const settings = this.embeddingSettings();
		if (!settings.enabled || index.embeddings.size === 0) {
			return [];
		}

		try {
			const [queryVector] = await embedTexts(settings, [query]);
			if (!queryVector) {
				return [];
			}

			return index.chunks
				.map((chunk): SearchResult | null => {
					const embedding = index.embeddings.get(chunk.id);
					if (!embedding) {
						return null;
					}
					const score = cosineSimilarity(queryVector, embedding.vector);
					return {
						file: chunk.file,
						score,
						excerpt: createEmbeddingExcerpt(chunk.content),
						matches: ['semantic'],
						chunk,
					};
				})
				.filter((result): result is SearchResult => result !== null && result.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
		} catch (error) {
			console.debug('VaultPilot embedding search failed. Falling back to BM25 only.', error);
			return [];
		}
	}

	private async ensureCacheDirectory() {
		const directory = `${this.vault.configDir}/${CACHE_DIR}`;
		if (!(await this.vault.adapter.exists(directory))) {
			await this.vault.adapter.mkdir(directory);
		}
	}

	private emit() {
		const stats = this.getStats();
		for (const listener of this.listeners) {
			listener(stats);
		}
	}
}

function buildVaultSignature(files: TFile[]): string {
	return files
		.map((file) => `${file.path}:${file.stat.size}:${file.stat.mtime}`)
		.sort()
		.join('|');
}

function getSearchableMarkdownFiles(vault: Vault): TFile[] {
	return vault.getMarkdownFiles().filter((file) => isSearchableMarkdownFile(file));
}

function isSearchableMarkdownFile(file: TFile): boolean {
	const normalizedPath = file.path.replaceAll('\\', '/');
	return !EXCLUDED_MARKDOWN_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

function serializeChunk(chunk: NoteChunk): SerializedChunk {
	return {
		id: chunk.id,
		filePath: chunk.file.path,
		title: chunk.title,
		headingPath: chunk.headingPath,
		content: chunk.content,
		contextText: chunk.contextText,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
	};
}

function deserializeChunk(chunk: SerializedChunk, filesByPath: Map<string, TFile>): NoteChunk | null {
	const file = filesByPath.get(chunk.filePath);
	if (!file) {
		return null;
	}
	return {
		id: chunk.id,
		file,
		title: chunk.title,
		headingPath: chunk.headingPath,
		content: chunk.content,
		contextText: chunk.contextText,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
	};
}

function createEmbeddingExcerpt(content: string): string {
	const line =
		content
			.split(/\r?\n/)
			.map((candidate) => candidate.trim())
			.find(Boolean) ?? '';
	return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function roundScore(score: number): number {
	return Math.round(score * 100) / 100;
}

function pruneWeakResults<T extends SearchResult & { queryHits: number }>(results: T[], limit: number): T[] {
	if (results.length === 0 || limit <= 0) {
		return [];
	}

	const topScore = results[0]?.score ?? 0;
	if (topScore < MIN_RELEVANT_SCORE) {
		return [];
	}

	const relativeFloor = roundScore(topScore * MIN_RELATIVE_RELEVANCE);
	const scoreFloor = Math.max(MIN_RELEVANT_SCORE, relativeFloor);

	return results
		.filter((result) => {
			if (result.score >= scoreFloor) {
				return true;
			}
			return result.queryHits > 1 && result.score >= MIN_MULTI_QUERY_RELEVANT_SCORE;
		})
		.slice(0, limit);
}

function normalizeFolderPath(path: string): string {
	return path.trim().replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

function isChunkInFolder(chunk: NoteChunk, folderPath: string): boolean {
	if (!folderPath) {
		return true;
	}
	const normalizedPath = chunk.file.path.replaceAll('\\', '/');
	return normalizedPath === folderPath || normalizedPath.startsWith(`${folderPath}/`);
}

function buildFolderFileSummaries(
	chunks: NoteChunk[],
	maxHeadingsPerFile: number,
	maxExcerptsPerFile: number,
): FolderInspection['files'] {
	const byFile = new Map<string, {
		path: string;
		basename: string;
		chunkCount: number;
		headings: string[];
		excerpts: string[];
	}>();

	for (const chunk of chunks) {
		const entry = byFile.get(chunk.file.path) ?? {
			path: chunk.file.path,
			basename: chunk.file.basename,
			chunkCount: 0,
			headings: [],
			excerpts: [],
		};
		entry.chunkCount += 1;
		for (const heading of chunk.headingPath) {
			if (entry.headings.length >= maxHeadingsPerFile) {
				break;
			}
			if (!entry.headings.includes(heading)) {
				entry.headings.push(heading);
			}
		}
		if (entry.excerpts.length < maxExcerptsPerFile) {
			const excerpt = firstContentLine(chunk.content);
			if (excerpt && !entry.excerpts.includes(excerpt)) {
				entry.excerpts.push(excerpt);
			}
		}
		byFile.set(chunk.file.path, entry);
	}

	return Array.from(byFile.values());
}

function topSubfolders(paths: string[], folderPath: string): FolderInspection['topSubfolders'] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const normalizedPath = path.replaceAll('\\', '/');
		const relative = folderPath && normalizedPath.startsWith(`${folderPath}/`)
			? normalizedPath.slice(folderPath.length + 1)
			: normalizedPath;
		const [firstSegment] = relative.split('/');
		if (!firstSegment || firstSegment.endsWith('.md')) {
			continue;
		}
		const subfolder = folderPath ? `${folderPath}/${firstSegment}` : firstSegment;
		counts.set(subfolder, (counts.get(subfolder) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([path, fileCount]) => ({ path, fileCount }))
		.sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path))
		.slice(0, 12);
}

function topHeadings(chunks: NoteChunk[]): FolderInspection['topHeadings'] {
	const counts = new Map<string, number>();
	for (const chunk of chunks) {
		for (const heading of chunk.headingPath) {
			if (!heading || heading === chunk.file.basename) {
				continue;
			}
			counts.set(heading, (counts.get(heading) ?? 0) + 1);
		}
	}
	return Array.from(counts.entries())
		.map(([heading, count]) => ({ heading, count }))
		.sort((a, b) => b.count - a.count || a.heading.localeCompare(b.heading))
		.slice(0, 20);
}

function firstContentLine(content: string): string {
	const line = content
		.split(/\r?\n/)
		.map((candidate) => candidate.replace(/^#+\s*/u, '').trim())
		.find(Boolean);
	if (!line) {
		return '';
	}
	return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.min(Math.round(value), max));
}

function hasLexicalEvidence(result: SearchResult & { bm25Score?: number; embeddingScore?: number }): boolean {
	return (result.bm25Score ?? 0) > 0 || result.matches.some((match) => match !== 'semantic');
}

function rerankScore(
	result: SearchResult & { retrievalScore: number; queryHits: number },
	queries: string[],
): number {
	const title = normalizeForRerank(result.file.basename);
	const path = normalizeForRerank(result.file.path);
	const heading = normalizeForRerank(result.chunk?.headingPath.join(' ') ?? result.chunk?.title ?? '');
	const queryText = normalizeForRerank(queries.join(' '));
	const queryTokens = tokenize(queries.join(' ')).map(normalizeForRerank);

	let boost = 0;
	if (title && queryText.includes(title)) {
		boost += 1.2;
	}
	if (path && queryText.includes(path)) {
		boost += 0.8;
	}
	if (queryTokens.some((token) => token.length > 2 && title.includes(token))) {
		boost += 0.7;
	}
	if (queryTokens.some((token) => token.length > 2 && path.includes(token))) {
		boost += 0.5;
	}
	if (queryTokens.some((token) => token.length > 2 && heading.includes(token))) {
		boost += 0.4;
	}
	boost += Math.min(result.queryHits, 3) * 0.08;

	return result.retrievalScore + boost;
}

function normalizeForRerank(value: string): string {
	return value
		.toLowerCase()
		.replace(/\.md$/u, '')
		.replace(/[_-]+/gu, ' ')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}
