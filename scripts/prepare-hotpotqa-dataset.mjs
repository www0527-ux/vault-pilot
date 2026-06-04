import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = process.cwd();
const vaultRoot = path.resolve(repoRoot, '..', '..', '..');
const sourceRoot = path.join(repoRoot, '.datasets', 'sources', 'hotpotqa');
const sourceFile = path.join(sourceRoot, 'hotpot_dev_distractor_v1.json');
const sourceUrl = 'https://curtis.ml.cmu.edu/datasets/hotpot/hotpot_dev_distractor_v1.json';
const fallbackSourceUrls = [
	'http://curtis.ml.cmu.edu/datasets/hotpot/hotpot_dev_distractor_v1.json',
	'https://huggingface.co/datasets/namlh2004/hotpotqa/resolve/main/hotpot_dev_distractor_v1.json?download=true',
];
const outputRoot = path.join(vaultRoot, '_rag_dataset', 'hotpotqa-dev-mini');
const docsRoot = path.join(outputRoot, 'docs');
const evalRoot = path.join(vaultRoot, '_rag_eval', 'hotpotqa-dev-mini');

const DEFAULT_SAMPLE_SIZE = 200;
const DEFAULT_SEED = 20260604;

async function main() {
	const options = parseArgs(process.argv.slice(2));
	await mkdir(sourceRoot, { recursive: true });

	if (options.download !== false) {
		await ensureSourceFile(options.forceDownload);
	}

	const raw = await readFile(sourceFile, 'utf8');
	const examples = JSON.parse(raw);
	if (!Array.isArray(examples)) {
		throw new Error('HotpotQA source file must be a JSON array.');
	}

	const sample = selectBalancedSample(examples, options.sampleSize, options.seed);
	const { documents, queries, qrels } = buildDataset(sample);

	await rm(outputRoot, { recursive: true, force: true });
	await rm(evalRoot, { recursive: true, force: true });
	await mkdir(docsRoot, { recursive: true });
	await mkdir(evalRoot, { recursive: true });

	for (const document of documents) {
		await writeFile(path.join(docsRoot, document.fileName), renderDocument(document), 'utf8');
	}

	await writeFile(path.join(outputRoot, 'README.md'), renderDatasetReadme(documents, queries), 'utf8');
	await writeFile(path.join(evalRoot, 'manifest.json'), JSON.stringify(renderManifest(documents, queries, options), null, 2), 'utf8');
	await writeFile(path.join(evalRoot, 'queries.jsonl'), queries.map((query) => JSON.stringify(query)).join('\n') + '\n', 'utf8');
	await writeFile(path.join(evalRoot, 'qrels.jsonl'), qrels.map((qrel) => JSON.stringify(qrel)).join('\n') + '\n', 'utf8');
	await writeFile(path.join(evalRoot, 'questions.md'), renderQuestionsMarkdown(queries), 'utf8');
	await writeFile(path.join(evalRoot, 'ablation-plan.md'), renderAblationPlan(), 'utf8');
	await writeFile(path.join(evalRoot, 'results-template.jsonl'), renderResultsTemplate(queries), 'utf8');
	await writeFile(path.join(evalRoot, 'results-template.csv'), renderResultsCsvTemplate(queries), 'utf8');

	console.log(`HotpotQA mini dataset ready.`);
	console.log(`Documents: ${documents.length}`);
	console.log(`Queries: ${queries.length}`);
	console.log(`Dataset: ${outputRoot}`);
	console.log(`Eval files: ${evalRoot}`);
}

async function ensureSourceFile(forceDownload) {
	if (!forceDownload) {
		try {
			const existing = await readFile(sourceFile);
			if (existing.length > 0) {
				return;
			}
		} catch {
			// Download below.
		}
	}

	const text = await downloadText([sourceUrl, ...fallbackSourceUrls]);
	await writeFile(sourceFile, text, 'utf8');
}

async function downloadText(urls) {
	const errors = [];
	for (const url of urls) {
		try {
			console.log(`Downloading HotpotQA dev distractor split from ${url}`);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return await response.text();
		} catch (error) {
			errors.push(`${url} via fetch: ${error.message}`);
		}

		try {
			console.log(`Retrying with curl: ${url}`);
			const { stdout } = await execFileAsync(
				'curl',
				['-L', '--connect-timeout', '60', '--max-time', '300', url],
				{ encoding: 'buffer', maxBuffer: 90 * 1024 * 1024 },
			);
			if (stdout.length > 0) {
				return stdout.toString('utf8');
			}
			throw new Error('curl returned an empty response');
		} catch (error) {
			errors.push(`${url} via curl: ${error.message}`);
		}
	}
	throw new Error(`HotpotQA download failed.\n${errors.join('\n')}`);
}

function parseArgs(args) {
	const options = {
		sampleSize: DEFAULT_SAMPLE_SIZE,
		seed: DEFAULT_SEED,
		download: true,
		forceDownload: false,
	};

	for (const arg of args) {
		if (arg.startsWith('--sample-size=')) {
			options.sampleSize = parsePositiveInteger(arg.split('=')[1], 'sample-size');
			continue;
		}
		if (arg.startsWith('--seed=')) {
			options.seed = parsePositiveInteger(arg.split('=')[1], 'seed');
			continue;
		}
		if (arg === '--no-download') {
			options.download = false;
			continue;
		}
		if (arg === '--force-download') {
			options.forceDownload = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function parsePositiveInteger(value, label) {
	const parsed = Number.parseInt(value ?? '', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer.`);
	}
	return parsed;
}

function selectBalancedSample(examples, sampleSize, seed) {
	const buckets = new Map();
	for (const example of examples) {
		if (!isUsableExample(example)) {
			continue;
		}
		const key = `${example.type ?? 'unknown'}:${example.level ?? 'unknown'}`;
		const bucket = buckets.get(key) ?? [];
		bucket.push(example);
		buckets.set(key, bucket);
	}

	const random = seededRandom(seed);
	const shuffledBuckets = Array.from(buckets.values()).map((bucket) => shuffle(bucket, random));
	const sample = [];
	let cursor = 0;
	while (sample.length < sampleSize && shuffledBuckets.some((bucket) => cursor < bucket.length)) {
		for (const bucket of shuffledBuckets) {
			const item = bucket[cursor];
			if (item) {
				sample.push(item);
				if (sample.length >= sampleSize) {
					break;
				}
			}
		}
		cursor += 1;
	}

	return sample.sort((left, right) => String(left._id).localeCompare(String(right._id)));
}

function isUsableExample(example) {
	return (
		typeof example?._id === 'string' &&
		typeof example.question === 'string' &&
		typeof example.answer === 'string' &&
		Array.isArray(example.context) &&
		Array.isArray(example.supporting_facts) &&
		example.supporting_facts.length > 0
	);
}

function buildDataset(examples) {
	const documentsByTitle = new Map();
	const queries = [];
	const qrels = [];

	for (let index = 0; index < examples.length; index += 1) {
		const example = examples[index];
		const queryId = `hotpotqa-${String(index + 1).padStart(4, '0')}`;
		const supportingTitles = Array.from(new Set(example.supporting_facts.map((fact) => fact[0]).filter(Boolean)));
		const expectedPaths = [];

		for (const contextItem of example.context) {
			const title = contextItem[0];
			const sentences = contextItem[1];
			if (typeof title !== 'string' || !Array.isArray(sentences)) {
				continue;
			}
			const document = upsertDocument(documentsByTitle, title, sentences);
			if (supportingTitles.includes(title)) {
				expectedPaths.push(document.relativePath);
				qrels.push({
					query_id: queryId,
					document_title: title,
					document_path: document.relativePath,
					relevance: 2,
				});
			}
		}

		queries.push({
			query_id: queryId,
			hotpotqa_id: example._id,
			question: example.question,
			answer: example.answer,
			type: example.type ?? 'unknown',
			level: example.level ?? 'unknown',
			expected_titles: supportingTitles,
			expected_paths: Array.from(new Set(expectedPaths)),
			supporting_facts: example.supporting_facts.map((fact) => ({
				title: fact[0],
				sentence_id: fact[1],
			})),
		});
	}

	const documents = Array.from(documentsByTitle.values()).sort((left, right) => left.title.localeCompare(right.title));
	return { documents, queries, qrels };
}

function upsertDocument(documentsByTitle, title, sentences) {
	const existing = documentsByTitle.get(title);
	if (existing) {
		for (const sentence of sentences) {
			if (typeof sentence === 'string' && sentence.trim()) {
				existing.sentences.add(sentence.trim());
			}
		}
		return existing;
	}

	const fileName = `${slugify(title)}.md`;
	const document = {
		title,
		fileName,
		relativePath: `_rag_dataset/hotpotqa-dev-mini/docs/${fileName}`,
		sentences: new Set(sentences.filter((sentence) => typeof sentence === 'string' && sentence.trim()).map((sentence) => sentence.trim())),
	};
	documentsByTitle.set(title, document);
	return document;
}

function renderDocument(document) {
	return `---\ndataset: hotpotqa-dev-mini\nsource: HotpotQA dev distractor\nsource_homepage: https://hotpotqa.github.io/\nhotpotqa_title: ${JSON.stringify(document.title)}\n---\n\n# ${document.title}\n\n${Array.from(document.sentences).join('\n\n')}\n`;
}

function renderDatasetReadme(documents, queries) {
	return `# HotpotQA dev mini RAG dataset\n\nThis folder contains a reproducible Obsidian Markdown conversion of a sampled HotpotQA dev distractor split.\n\n- Source: https://hotpotqa.github.io/\n- Raw file used by the script: ${sourceUrl}\n- Generated documents: ${documents.length}\n- Evaluation questions: ${queries.length}\n- Purpose: retrieval and RAG ablation experiments for VaultPilot\n\nThe document files intentionally do not include the evaluation questions or answers. This avoids leaking labels into the retrievable corpus.\n\nEvaluation files are in \`_rag_eval/hotpotqa-dev-mini\`.\n`;
}

function renderManifest(documents, queries, options) {
	return {
		name: 'hotpotqa-dev-mini',
		source: 'HotpotQA dev distractor',
		source_url: sourceUrl,
		source_homepage: 'https://hotpotqa.github.io/',
		sample_size: options.sampleSize,
		seed: options.seed,
		document_count: documents.length,
		query_count: queries.length,
		corpus_root: '_rag_dataset/hotpotqa-dev-mini/docs',
		queries_file: '_rag_eval/hotpotqa-dev-mini/queries.jsonl',
		qrels_file: '_rag_eval/hotpotqa-dev-mini/qrels.jsonl',
	};
}

function renderQuestionsMarkdown(queries) {
	const rows = queries.map((query) => {
		return `| ${query.query_id} | ${escapeMarkdownTable(query.question)} | ${escapeMarkdownTable(query.answer)} | ${query.expected_titles.map(escapeMarkdownTable).join('<br>')} | ${query.type} | ${query.level} |`;
	});
	return `# HotpotQA dev mini questions\n\n| ID | Question | Gold answer | Expected evidence pages | Type | Level |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}

function renderAblationPlan() {
	return `# HotpotQA ablation plan\n\nUse this public dataset after the smaller Chinese note set. Keep the corpus and query list fixed across all runs.\n\n## Retrieval variants\n\n| Mode | Description | Expected lesson |\n| --- | --- | --- |\n| bm25_only | Keyword retrieval only | Strong on exact entity/title matches; weaker on paraphrases. |\n| embedding_only | Dense vector retrieval only | Strong on semantic similarity; may miss exact rare entities. |\n| hybrid_weighted_50_50 | Current weighted score fusion | Baseline hybrid setup. |\n| hybrid_weighted_30_70 | Lower BM25 weight, higher embedding weight | Tests whether semantic retrieval should dominate QA-style queries. |\n| hybrid_rrf | Reciprocal Rank Fusion over BM25 and embedding ranks | Avoids comparing incompatible raw scores. |\n| hybrid_rrf_rerank | RRF followed by a reranker | Tests whether final precision improves after broad recall. |\n\n## Suggested metrics\n\n- Top-1 hit: at least one expected evidence page is ranked first.\n- Recall@3 / Recall@5: at least one expected evidence page appears in the top k.\n- All-gold Recall@5: all expected evidence pages appear in the top 5. This is important for multi-hop HotpotQA.\n- MRR: reciprocal rank of the first expected evidence page.\n\n## Result export format\n\nWrite one JSON object per query:\n\n\`\`\`json\n{\"mode\":\"bm25_only\",\"query_id\":\"hotpotqa-0001\",\"retrieved\":[{\"path\":\"_rag_dataset/hotpotqa-dev-mini/docs/example.md\",\"title\":\"Example\",\"score\":1.23}]}\n\`\`\`\n\nThen run:\n\n\`\`\`bash\nnpm run eval:retrieval -- --results ../../_rag_eval/hotpotqa-dev-mini/results.jsonl --qrels ../../_rag_eval/hotpotqa-dev-mini/qrels.jsonl\n\`\`\`\n`;
}

function renderResultsTemplate(queries) {
	return queries
		.slice(0, 3)
		.map((query) =>
			JSON.stringify({
				mode: 'bm25_only',
				query_id: query.query_id,
				retrieved: [],
			}),
		)
		.join('\n') + '\n';
}

function renderResultsCsvTemplate(queries) {
	const rows = queries.map((query) => `${query.query_id},,,,,`);
	return `query_id,bm25_only,embedding_only,hybrid_weighted_50_50,hybrid_rrf,notes\n${rows.join('\n')}\n`;
}

function escapeMarkdownTable(value) {
	return String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, ' ');
}

function slugify(value) {
	const ascii = value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/gu, '')
		.toLowerCase()
		.replace(/&/gu, ' and ')
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-|-$/gu, '')
		.slice(0, 90);
	return ascii || `doc-${hashString(value)}`;
}

function hashString(value) {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = Math.imul(1664525, state) + 1013904223;
		return (state >>> 0) / 4294967296;
	};
}

function shuffle(items, random) {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
	}
	return copy;
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
