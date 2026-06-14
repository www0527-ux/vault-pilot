import { TFile } from 'obsidian';
import { extractHeadings, tokenize } from './text';
import { QueryRewrite } from './types';

const MAX_KEYWORDS = 12;
const MAX_HEADING_KEYWORDS = 6;
const MAX_QUERIES = 6;

type RemoteRewriteCandidate = Partial<QueryRewrite> & {
	queries?: unknown;
};

export function buildRuleBasedRewrite(
	question: string,
	activeFile: TFile | null,
	activeContent: string,
	warning?: string,
): QueryRewrite {
	const keywords = extractRuleKeywords(question, activeFile, activeContent);
	const keywordQuery = Array.from(new Set([question, ...keywords])).join(' ');
	const rewrittenQueries = normalizeQueries([question, keywordQuery]);

	return {
		originalQuestion: question,
		rewrittenQuery: rewrittenQueries[0] ?? question,
		rewrittenQueries,
		keywords,
		method: 'rule-based',
		confidence: keywords.length > 0 ? 'medium' : 'low',
		warning,
	};
}

export function normalizeRemoteRewrite(
	question: string,
	candidate: RemoteRewriteCandidate,
): QueryRewrite | null {
	const queryCandidates = Array.isArray(candidate.queries)
		? candidate.queries.filter((query): query is string => typeof query === 'string')
		: [];
	const rewrittenQueries = normalizeQueries([
		question,
		candidate.rewrittenQuery,
		...queryCandidates,
	]);

	if (rewrittenQueries.length === 0) {
		return null;
	}

	const keywords = Array.isArray(candidate.keywords)
		? candidate.keywords
			.filter((keyword) => typeof keyword === 'string' && keyword.trim())
			.slice(0, MAX_KEYWORDS)
		: [];

	return {
		originalQuestion: question,
		rewrittenQuery: rewrittenQueries[0] ?? question,
		rewrittenQueries,
		keywords,
		method: 'remote',
		confidence: normalizeConfidence(candidate.confidence),
		warning: candidate.warning,
	};
}

function extractRuleKeywords(question: string, activeFile: TFile | null, activeContent: string): string[] {
	const queryTokens = tokenize(question).slice(0, MAX_KEYWORDS);
	const headingTokens = extractHeadings(activeContent)
		.slice(0, MAX_HEADING_KEYWORDS)
		.flatMap((heading) => tokenize(heading));
	const fileTokens = activeFile ? tokenize(`${activeFile.basename} ${activeFile.path}`) : [];

	return Array.from(new Set([...queryTokens, ...headingTokens, ...fileTokens])).slice(0, MAX_KEYWORDS);
}

function normalizeQueries(values: unknown[]): string[] {
	const queries = values
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter(Boolean);

	return Array.from(new Set(queries)).slice(0, MAX_QUERIES);
}

function normalizeConfidence(value: unknown): 'low' | 'medium' | 'high' {
	if (value === 'low' || value === 'medium' || value === 'high') {
		return value;
	}
	return 'medium';
}
