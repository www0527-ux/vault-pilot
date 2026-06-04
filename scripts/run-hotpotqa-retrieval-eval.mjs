import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const vaultRoot = path.resolve(repoRoot, '..', '..', '..');
const evalRoot = path.join(vaultRoot, '_rag_eval', 'hotpotqa-dev-mini');
const cachePath = path.join(vaultRoot, '.obsidian', 'vaultpilot', 'index-cache.json');
const queriesPath = path.join(evalRoot, 'queries.jsonl');
const qrelsPath = path.join(evalRoot, 'qrels.jsonl');
const queryEmbeddingCachePath = path.join(evalRoot, 'query-embeddings.json');
const outputPath = path.join(evalRoot, 'retrieval-results-abcde.jsonl');
const summaryPath = path.join(evalRoot, 'retrieval-summary-abcde.md');

const CORPUS_PREFIX = '_rag_dataset/hotpotqa-dev-mini/docs/';
const TOP_K = 5;
const BM25_CANDIDATE_LIMIT = 50;
const EMBEDDING_CANDIDATE_LIMIT = 50;
const EMBEDDING_ENDPOINT = 'http://localhost:11434/api/embed';
const EMBEDDING_MODEL = 'nomic-embed-text';
const QUERY_BATCH_SIZE = 16;

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const HEADING_BOOST = 1.6;
const FILE_BOOST = 1.2;

async function main() {
	const cache = JSON.parse(await readFile(cachePath, 'utf8'));
	const queries = await readJsonl(queriesPath);
	const qrels = await readJsonl(qrelsPath);
	const chunks = cache.chunks.filter((chunk) => normalizePath(chunk.filePath).startsWith(CORPUS_PREFIX));
	const embeddings = new Map((cache.embeddings ?? []).map((embedding) => [embedding.chunkId, embedding]));

	if (chunks.length === 0) {
		throw new Error(`No cached chunks found under ${CORPUS_PREFIX}. Open VaultPilot once after building the dataset.`);
	}

	const embeddedChunks = chunks.filter((chunk) => embeddings.has(chunk.id));
	if (embeddedChunks.length === 0) {
		throw new Error('No cached HotpotQA embeddings found. Build VaultPilot embeddings before running embedding eval.');
	}

	console.log(`Loaded ${chunks.length} HotpotQA chunks, ${embeddedChunks.length} cached embeddings, ${queries.length} queries.`);

	const bm25Index = buildBm25Index(chunks);
	const queryEmbeddings = await loadOrBuildQueryEmbeddings(queries);
	const rows = [];

	for (const query of queries) {
		const queryTokens = tokenize(query.question);
		const bm25Results = searchBm25Index(bm25Index, queryTokens, BM25_CANDIDATE_LIMIT);
		const embeddingResults = searchEmbeddings(chunks, embeddings, queryEmbeddings.get(query.query_id), EMBEDDING_CANDIDATE_LIMIT);

		rows.push(renderResultRow('bm25_only', query.query_id, bm25Results.slice(0, TOP_K)));
		rows.push(renderResultRow('embedding_only', query.query_id, embeddingResults.slice(0, TOP_K)));
		rows.push(renderResultRow('hybrid_weighted_50_50', query.query_id, hybridResults(bm25Results, embeddingResults, 0.5, 0.5).slice(0, TOP_K)));
		rows.push(renderResultRow('hybrid_weighted_30_70', query.query_id, hybridResults(bm25Results, embeddingResults, 0.3, 0.7).slice(0, TOP_K)));
		rows.push(renderResultRow('hybrid_rrf', query.query_id, rrfResults([bm25Results, embeddingResults]).slice(0, TOP_K)));
	}

	await writeFile(outputPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
	const summary = renderSummary(rows, qrels, chunks.length, embeddedChunks.length, queries.length);
	await writeFile(summaryPath, summary, 'utf8');
	console.log(`Wrote results: ${outputPath}`);
	console.log(`Wrote summary: ${summaryPath}`);
	console.log(summary);
}

async function readJsonl(filePath) {
	const raw = await readFile(filePath, 'utf8');
	return raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function loadOrBuildQueryEmbeddings(queries) {
	const cached = await readQueryEmbeddingCache();
	const byId = new Map(cached.embeddings.map((item) => [item.query_id, item.vector]));
	const missing = queries.filter((query) => !byId.has(query.query_id));

	if (missing.length === 0 && cached.model === EMBEDDING_MODEL) {
		console.log(`Loaded ${byId.size} query embeddings from cache.`);
		return byId;
	}

	if (cached.model !== EMBEDDING_MODEL) {
		byId.clear();
		missing.splice(0, missing.length, ...queries);
	}

	console.log(`Embedding ${missing.length} missing queries with ${EMBEDDING_MODEL}.`);
	for (let index = 0; index < missing.length; index += QUERY_BATCH_SIZE) {
		const batch = missing.slice(index, index + QUERY_BATCH_SIZE);
		const vectors = await embedTexts(batch.map((query) => query.question));
		for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
			const query = batch[batchIndex];
			const vector = vectors[batchIndex];
			if (query && vector) {
				byId.set(query.query_id, vector);
			}
		}
		console.log(`Embedded ${Math.min(index + batch.length, missing.length)} / ${missing.length} missing queries.`);
	}

	await writeFile(
		queryEmbeddingCachePath,
		JSON.stringify({
			model: EMBEDDING_MODEL,
			endpoint: EMBEDDING_ENDPOINT,
			embeddings: Array.from(byId, ([query_id, vector]) => ({ query_id, vector })),
		}),
		'utf8',
	);
	return byId;
}

async function readQueryEmbeddingCache() {
	try {
		const raw = await readFile(queryEmbeddingCachePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.embeddings)) {
			return parsed;
		}
	} catch {
		// Cache is optional.
	}
	return { model: EMBEDDING_MODEL, embeddings: [] };
}

async function embedTexts(texts) {
	const response = await fetch(EMBEDDING_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: EMBEDDING_MODEL,
			input: texts,
		}),
	});
	if (!response.ok) {
		throw new Error(`Embedding HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
	}
	const data = await response.json();
	if (Array.isArray(data.embeddings)) {
		return data.embeddings;
	}
	if (Array.isArray(data.embedding)) {
		return [data.embedding];
	}
	throw new Error('Embedding response did not contain embeddings.');
}

function buildBm25Index(chunks) {
	const indexedChunks = chunks.map((chunk) => {
		const tokens = tokenize(chunkSearchText(chunk));
		const termFrequency = new Map();
		for (const token of tokens) {
			termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
		}
		return {
			chunk,
			tokens,
			termFrequency,
			length: tokens.length,
			headingTokens: new Set(tokenize(chunk.headingPath.join(' '))),
			fileTokens: new Set(tokenize(`${basename(chunk.filePath)} ${chunk.filePath}`)),
		};
	});

	const documentFrequency = new Map();
	const invertedIndex = new Map();
	for (let chunkIndex = 0; chunkIndex < indexedChunks.length; chunkIndex += 1) {
		const indexedChunk = indexedChunks[chunkIndex];
		for (const token of new Set(indexedChunk.tokens)) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
			const postings = invertedIndex.get(token) ?? new Set();
			postings.add(chunkIndex);
			invertedIndex.set(token, postings);
		}
	}

	const averageLength = indexedChunks.reduce((total, chunk) => total + chunk.length, 0) / indexedChunks.length;
	return { chunks: indexedChunks, documentFrequency, invertedIndex, averageLength };
}

function searchBm25Index(index, queryTokens, limit) {
	if (queryTokens.length === 0) {
		return [];
	}
	const candidateIndexes = new Set();
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
		.map((chunkIndex) => scoreIndexedChunk(index, index.chunks[chunkIndex], queryTokens))
		.filter(Boolean)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
}

function scoreIndexedChunk(index, indexedChunk, queryTokens) {
	let score = 0;
	const uniqueQueryTokens = Array.from(new Set(queryTokens));

	for (const token of uniqueQueryTokens) {
		const frequency = indexedChunk.termFrequency.get(token) ?? 0;
		const headingHit = indexedChunk.headingTokens.has(token);
		const fileHit = indexedChunk.fileTokens.has(token);
		if (frequency <= 0 && !headingHit && !fileHit) {
			continue;
		}

		const idf = inverseDocumentFrequency(index.chunks.length, index.documentFrequency.get(token) ?? 0);
		const bm25 = frequency > 0 ? bm25TermScore(frequency, indexedChunk.length, index.averageLength) : 0;
		const boost = (headingHit ? HEADING_BOOST : 1) * (fileHit ? FILE_BOOST : 1);
		score += idf * (bm25 * boost + (headingHit ? 0.6 : 0) + (fileHit ? 0.2 : 0));
	}

	return score > 0 ? toSearchResult(indexedChunk.chunk, score) : null;
}

function searchEmbeddings(chunks, embeddings, queryVector, limit) {
	if (!queryVector) {
		return [];
	}
	return chunks
		.map((chunk) => {
			const embedding = embeddings.get(chunk.id);
			if (!embedding) {
				return null;
			}
			const score = cosineSimilarity(queryVector, embedding.vector);
			return score > 0 ? toSearchResult(chunk, score) : null;
		})
		.filter(Boolean)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
}

function hybridResults(bm25Results, embeddingResults, bm25Weight, embeddingWeight) {
	const merged = new Map();
	const maxBm25 = Math.max(...bm25Results.map((result) => result.score), 0);
	const maxEmbedding = Math.max(...embeddingResults.map((result) => result.score), 0);

	for (const result of bm25Results) {
		merged.set(result.chunkId, {
			...result,
			bm25Score: maxBm25 > 0 ? result.score / maxBm25 : 0,
			embeddingScore: 0,
		});
	}

	for (const result of embeddingResults) {
		const embeddingScore = maxEmbedding > 0 ? result.score / maxEmbedding : 0;
		const existing = merged.get(result.chunkId);
		if (existing) {
			existing.embeddingScore = embeddingScore;
			continue;
		}
		merged.set(result.chunkId, {
			...result,
			bm25Score: 0,
			embeddingScore,
		});
	}

	return Array.from(merged.values())
		.map((result) => ({
			...result,
			score: (result.bm25Score ?? 0) * bm25Weight + (result.embeddingScore ?? 0) * embeddingWeight,
		}))
		.sort((left, right) => right.score - left.score);
}

function rrfResults(resultLists, rrfK = 60) {
	const merged = new Map();
	for (const results of resultLists) {
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index];
			if (!result) {
				continue;
			}
			const existing = merged.get(result.chunkId) ?? {
				...result,
				score: 0,
				sourceScore: result.score,
			};
			existing.score += 1 / (rrfK + index + 1);
			existing.sourceScore = Math.max(existing.sourceScore ?? 0, result.score);
			merged.set(result.chunkId, existing);
		}
	}

	return Array.from(merged.values()).sort((left, right) => {
		if (right.score !== left.score) {
			return right.score - left.score;
		}
		return (right.sourceScore ?? 0) - (left.sourceScore ?? 0);
	});
}

function renderResultRow(mode, queryId, results) {
	return {
		mode,
		query_id: queryId,
		retrieved: results.map((result) => ({
			path: result.path,
			title: result.title,
			chunk_id: result.chunkId,
			score: roundScore(result.score),
		})),
	};
}

function renderSummary(rows, qrels, chunkCount, embeddingCount, queryCount) {
	const goldByQuery = buildGoldMap(qrels);
	const grouped = groupByMode(rows);
	const lines = [
		'# HotpotQA ABCDE retrieval eval summary',
		'',
		`Generated at: ${new Date().toISOString()}`,
		'',
		'## Setup',
		'',
		`- Corpus chunks: ${chunkCount}`,
		`- Cached document embeddings: ${embeddingCount}`,
		`- Queries: ${queryCount}`,
		`- Top-k: ${TOP_K}`,
		`- Query embedding cache: \`_rag_eval/hotpotqa-dev-mini/query-embeddings.json\``,
		'',
		'## Metrics',
		'',
		'| Mode | Evaluated | Top-1 hit | Recall@3 | Recall@5 | All-gold Recall@5 | MRR |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
	];

	for (const [mode, modeRows] of grouped) {
		const metrics = evaluateRows(modeRows, goldByQuery);
		lines.push(
			`| ${mode} | ${metrics.evaluated} | ${percent(metrics.top1)} | ${percent(metrics.recall3)} | ${percent(metrics.recall5)} | ${percent(metrics.allGold5)} | ${metrics.mrr.toFixed(4)} |`,
		);
	}

	lines.push('', 'Results JSONL: `_rag_eval/hotpotqa-dev-mini/retrieval-results-abcde.jsonl`', '');
	return lines.join('\n');
}

function buildGoldMap(qrels) {
	const goldByQuery = new Map();
	for (const qrel of qrels) {
		const queryId = qrel.query_id;
		const documentPath = normalizePath(qrel.document_path);
		const gold = goldByQuery.get(queryId) ?? new Set();
		gold.add(documentPath);
		goldByQuery.set(queryId, gold);
	}
	return goldByQuery;
}

function groupByMode(rows) {
	const grouped = new Map();
	for (const row of rows) {
		const modeRows = grouped.get(row.mode) ?? [];
		modeRows.push(row);
		grouped.set(row.mode, modeRows);
	}
	return grouped;
}

function evaluateRows(rows, goldByQuery) {
	let evaluated = 0;
	let top1 = 0;
	let recall3 = 0;
	let recall5 = 0;
	let allGold5 = 0;
	let reciprocalRankTotal = 0;

	for (const row of rows) {
		const gold = goldByQuery.get(row.query_id);
		if (!gold) {
			continue;
		}
		evaluated += 1;
		const retrieved = row.retrieved.map((item) => normalizePath(item.path));
		const firstGoldRank = retrieved.findIndex((item) => gold.has(item));
		if (firstGoldRank === 0) {
			top1 += 1;
		}
		if (firstGoldRank >= 0 && firstGoldRank < 3) {
			recall3 += 1;
		}
		if (firstGoldRank >= 0 && firstGoldRank < 5) {
			recall5 += 1;
		}
		if (firstGoldRank >= 0) {
			reciprocalRankTotal += 1 / (firstGoldRank + 1);
		}
		const top5 = new Set(retrieved.slice(0, 5));
		if (Array.from(gold).every((item) => top5.has(item))) {
			allGold5 += 1;
		}
	}

	return {
		evaluated,
		top1: ratio(top1, evaluated),
		recall3: ratio(recall3, evaluated),
		recall5: ratio(recall5, evaluated),
		allGold5: ratio(allGold5, evaluated),
		mrr: ratio(reciprocalRankTotal, evaluated),
	};
}

function toSearchResult(chunk, score) {
	return {
		chunkId: chunk.id,
		path: normalizePath(chunk.filePath),
		title: chunk.title || basename(chunk.filePath),
		score,
	};
}

function chunkSearchText(chunk) {
	return [basename(chunk.filePath), chunk.filePath, chunk.headingPath.join(' '), chunk.contextText, chunk.content].join('\n');
}

function tokenize(input) {
	const tokens = new Set();
	const segments = input
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
		.split(/\s+/u)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);

	for (const segment of segments) {
		if (/[\u3400-\u9fff]/u.test(segment)) {
			tokens.add(segment);
			const chars = Array.from(segment);
			for (let index = 0; index < chars.length - 1; index += 1) {
				tokens.add(`${chars[index]}${chars[index + 1]}`);
			}
			continue;
		}
		if (isUsefulLatinToken(segment)) {
			tokens.add(segment);
		}
	}

	return Array.from(tokens).slice(0, 60);
}

function isUsefulLatinToken(token) {
	return token.length >= 3 && !LATIN_STOP_WORDS.has(token) && /[a-z0-9]/u.test(token);
}

function inverseDocumentFrequency(totalDocuments, documentFrequency) {
	return Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25TermScore(frequency, documentLength, averageLength) {
	const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (documentLength / averageLength));
	return (frequency * (BM25_K1 + 1)) / denominator;
}

function cosineSimilarity(left, right) {
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
	return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizePath(value) {
	return String(value).replaceAll('\\', '/').replace(/^\/+/u, '');
}

function basename(filePath) {
	return path.basename(filePath, path.extname(filePath));
}

function ratio(numerator, denominator) {
	return denominator > 0 ? numerator / denominator : 0;
}

function percent(value) {
	return `${(value * 100).toFixed(2)}%`;
}

function roundScore(value) {
	return Math.round(value * 10000) / 10000;
}

const LATIN_STOP_WORDS = new Set([
	'and',
	'are',
	'but',
	'can',
	'for',
	'from',
	'has',
	'have',
	'how',
	'its',
	'not',
	'that',
	'the',
	'this',
	'what',
	'when',
	'where',
	'which',
	'who',
	'why',
	'with',
]);

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
