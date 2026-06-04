import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const qrels = await readJsonl(resolveInput(options.qrels));
	const results = await readJsonl(resolveInput(options.results));
	const goldByQuery = buildGoldMap(qrels);
	const groupedResults = groupByMode(results);

	for (const [mode, rows] of groupedResults) {
		const metrics = evaluateMode(rows, goldByQuery);
		printMetrics(mode, metrics);
	}
}

function parseArgs(args) {
	const options = {
		qrels: null,
		results: null,
	};

	for (const arg of args) {
		if (arg.startsWith('--qrels=')) {
			options.qrels = arg.split('=')[1];
			continue;
		}
		if (arg.startsWith('--results=')) {
			options.results = arg.split('=')[1];
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.qrels || !options.results) {
		throw new Error('Usage: node scripts/evaluate-retrieval-results.mjs --qrels=path/to/qrels.jsonl --results=path/to/results.jsonl');
	}
	return options;
}

function resolveInput(inputPath) {
	return path.resolve(process.cwd(), inputPath);
}

async function readJsonl(filePath) {
	const raw = await readFile(filePath, 'utf8');
	return raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function buildGoldMap(qrels) {
	const goldByQuery = new Map();
	for (const qrel of qrels) {
		const queryId = qrel.query_id;
		const pathValue = normalizePath(qrel.document_path);
		if (!queryId || !pathValue) {
			continue;
		}
		const gold = goldByQuery.get(queryId) ?? new Set();
		gold.add(pathValue);
		goldByQuery.set(queryId, gold);
	}
	return goldByQuery;
}

function groupByMode(results) {
	const grouped = new Map();
	for (const row of results) {
		const mode = row.mode ?? 'unknown';
		const rows = grouped.get(mode) ?? [];
		rows.push(row);
		grouped.set(mode, rows);
	}
	return grouped;
}

function evaluateMode(rows, goldByQuery) {
	let evaluated = 0;
	let top1 = 0;
	let recall3 = 0;
	let recall5 = 0;
	let allGold5 = 0;
	let reciprocalRankTotal = 0;
	const missingQueries = [];

	for (const row of rows) {
		const gold = goldByQuery.get(row.query_id);
		if (!gold) {
			missingQueries.push(row.query_id);
			continue;
		}

		const retrieved = Array.isArray(row.retrieved) ? row.retrieved.map(resultPath).filter(Boolean) : [];
		evaluated += 1;

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
		missingQueries,
		top1: ratio(top1, evaluated),
		recall3: ratio(recall3, evaluated),
		recall5: ratio(recall5, evaluated),
		allGold5: ratio(allGold5, evaluated),
		mrr: ratio(reciprocalRankTotal, evaluated),
	};
}

function resultPath(result) {
	if (typeof result === 'string') {
		return normalizePath(result);
	}
	return normalizePath(result?.path ?? result?.document_path ?? result?.file);
}

function normalizePath(value) {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}
	return value.replaceAll('\\', '/').replace(/^\/+/u, '');
}

function ratio(numerator, denominator) {
	return denominator > 0 ? numerator / denominator : 0;
}

function printMetrics(mode, metrics) {
	const percent = (value) => `${(value * 100).toFixed(2)}%`;
	console.log(`\nMode: ${mode}`);
	console.log(`Evaluated queries: ${metrics.evaluated}`);
	console.log(`Top-1 hit: ${percent(metrics.top1)}`);
	console.log(`Recall@3: ${percent(metrics.recall3)}`);
	console.log(`Recall@5: ${percent(metrics.recall5)}`);
	console.log(`All-gold Recall@5: ${percent(metrics.allGold5)}`);
	console.log(`MRR: ${metrics.mrr.toFixed(4)}`);
	if (metrics.missingQueries.length > 0) {
		console.log(`Missing qrels for ${metrics.missingQueries.length} result rows.`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
