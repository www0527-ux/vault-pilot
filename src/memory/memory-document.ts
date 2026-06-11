const MEMORY_ENTRY_PATTERN = /- id: ([^\n]+)\n[ ]{2}status: (active|archived)\n[ ]{2}scope: ([^\n]+)\n[ ]{2}updated: ([^\n]+)(?:\n[ ]{2}archived: ([^\n]+))?\n[ ]{2}content: ([^\n]+)/gu;

export type MemoryScope = 'preference' | 'environment' | 'project' | 'decision' | 'vaultpilot-ui';

export type MemoryRequest =
	| { type: 'remember'; content: string }
	| { type: 'forget'; content: string };

export interface MemorySaveResult {
	action: 'created' | 'updated' | 'unchanged';
	id: string;
	scope: MemoryScope;
	content: string;
	updatedDocument: string;
	previousContent?: string;
}

export interface MemoryForgetResult {
	count: number;
	updatedDocument: string;
}

interface MemoryEntry {
	id: string;
	status: 'active' | 'archived';
	scope: MemoryScope;
	updated: string;
	archived?: string;
	content: string;
}

interface ParsedMemoryEntry extends MemoryEntry {
	raw: string;
}

export function normalizeMemoryDocument(content: string): string {
	const lines = content.trim() ? content.trim().split(/\r?\n/u) : ['# VaultPilot Memory'];
	let normalized = lines.join('\n');
	for (const heading of ['## Preferences', '## Environment', '## Project Facts', '## Confirmed Decisions', '## Archived']) {
		if (!normalized.includes(heading)) {
			normalized = `${normalized.trim()}\n\n${heading}\n`;
		}
	}
	return `${normalized.trim()}\n`;
}

export function saveMemoryDocument(source: string, content: string, now = new Date(), idFactory = createMemoryId): MemorySaveResult | null {
	const cleaned = content.trim();
	if (!cleaned) {
		return null;
	}
	const current = normalizeMemoryDocument(source);
	const scope = inferMemoryScope(cleaned);
	const existing = findReusableMemory(current, cleaned, scope);
	if (existing && normalizeForCompare(existing.content) === normalizeForCompare(cleaned)) {
		return {
			action: 'unchanged',
			id: existing.id,
			scope: existing.scope,
			content: existing.content,
			updatedDocument: current,
		};
	}
	if (existing) {
		const updated: MemoryEntry = {
			id: existing.id,
			status: 'active',
			scope,
			updated: formatDate(now),
			content: cleaned,
		};
		return {
			action: 'updated',
			id: existing.id,
			scope,
			content: cleaned,
			previousContent: existing.content,
			updatedDocument: replaceMemoryEntry(current, existing, updated),
		};
	}
	const entry: MemoryEntry = {
		id: idFactory(),
		status: 'active',
		scope,
		updated: formatDate(now),
		content: cleaned,
	};
	return {
		action: 'created',
		id: entry.id,
		scope,
		content: cleaned,
		updatedDocument: insertUnderHeading(current, headingForScope(scope), formatMemoryEntry(entry)),
	};
}

export function updateMemoryDocument(source: string, query: string, content: string, now = new Date()): MemorySaveResult | null {
	const cleanedQuery = query.trim();
	const cleanedContent = content.trim();
	if (!cleanedQuery || !cleanedContent) {
		return null;
	}
	const current = normalizeMemoryDocument(source);
	const existing = findBestMemoryMatch(current, cleanedQuery);
	if (!existing) {
		return null;
	}
	const scope = inferMemoryScope(cleanedContent);
	const updated: MemoryEntry = {
		id: existing.id,
		status: 'active',
		scope,
		updated: formatDate(now),
		content: cleanedContent,
	};
	return {
		action: 'updated',
		id: existing.id,
		scope,
		content: cleanedContent,
		previousContent: existing.content,
		updatedDocument: replaceMemoryEntry(current, existing, updated),
	};
}

export function forgetMemoryDocument(source: string, query: string, now = new Date()): MemoryForgetResult {
	const cleaned = query.trim().toLowerCase();
	if (!cleaned) {
		return { count: 0, updatedDocument: normalizeMemoryDocument(source) };
	}
	let count = 0;
	const current = normalizeMemoryDocument(source);
	const updated = current.replace(
		MEMORY_ENTRY_PATTERN,
		(match, id: string, status: string, scope: string, updatedAt: string, _archived: string | undefined, content: string) => {
			if (status !== 'active' || !content.toLowerCase().includes(cleaned)) {
				return match;
			}
			count += 1;
			return formatMemoryEntry({
				id,
				status: 'archived',
				scope: normalizeScope(scope),
				updated: updatedAt,
				archived: formatDate(now),
				content,
			}).trimEnd();
		},
	);
	return { count, updatedDocument: updated };
}

export function parseMemoryRequest(question: string): MemoryRequest | null {
	const trimmed = question.trim();
	const rememberPatterns = [
		/^(?:\u8bf7)?\u8bb0\u4f4f[\s:：,，]*(.+)$/u,
		/^remember(?: that)?[\s:]+(.+)$/iu,
		/^save (?:this )?(?:memory|preference)[\s:]+(.+)$/iu,
	];
	const forgetPatterns = [
		/^(?:\u8bf7)?(?:\u5fd8\u8bb0|\u5220\u9664\u8bb0\u5fc6|\u79fb\u9664\u8bb0\u5fc6)[\s:：,，]*(.+)$/u,
		/^(?:forget|remove memory|delete memory)[\s:]+(.+)$/iu,
	];
	const remembered = matchFirst(trimmed, rememberPatterns);
	if (remembered) {
		return { type: 'remember', content: remembered };
	}
	const forgotten = matchFirst(trimmed, forgetPatterns);
	if (forgotten) {
		return { type: 'forget', content: forgotten };
	}
	return null;
}

function formatMemoryEntry(entry: MemoryEntry): string {
	return [
		`- id: ${entry.id}`,
		`  status: ${entry.status}`,
		`  scope: ${entry.scope}`,
		`  updated: ${entry.updated}`,
		entry.archived ? `  archived: ${entry.archived}` : '',
		`  content: ${entry.content}`,
		'',
	].filter((line) => line !== '').join('\n');
}

function insertUnderHeading(source: string, heading: string, entry: string): string {
	const index = source.indexOf(heading);
	if (index === -1) {
		return `${source.trim()}\n\n${heading}\n${entry}`;
	}
	const insertAt = index + heading.length;
	return `${source.slice(0, insertAt)}\n${entry}${source.slice(insertAt).replace(/^\s*/u, '\n')}`;
}

function replaceMemoryEntry(source: string, existing: ParsedMemoryEntry, updated: MemoryEntry): string {
	const withoutExisting = source.replace(existing.raw, '').replace(/\n{3,}/gu, '\n\n');
	return insertUnderHeading(withoutExisting, headingForScope(updated.scope), formatMemoryEntry(updated));
}

function parseMemoryEntries(source: string): ParsedMemoryEntry[] {
	return Array.from(source.matchAll(MEMORY_ENTRY_PATTERN)).map((match) => ({
		id: match[1] ?? '',
		status: normalizeStatus(match[2]),
		scope: normalizeScope(match[3] ?? ''),
		updated: match[4] ?? '',
		archived: match[5],
		content: match[6] ?? '',
		raw: match[0] ?? '',
	}));
}

function findReusableMemory(source: string, content: string, scope: MemoryScope): ParsedMemoryEntry | null {
	const activeEntries = parseMemoryEntries(source).filter((entry) => entry.status === 'active');
	const sameScope = activeEntries.filter((entry) => entry.scope === scope);
	const exact = sameScope.find((entry) => normalizeForCompare(entry.content) === normalizeForCompare(content));
	if (exact) {
		return exact;
	}
	const scored = sameScope
		.map((entry) => ({ entry, score: similarityScore(entry.content, content) }))
		.sort((left, right) => right.score - left.score);
	return scored[0] && scored[0].score >= 0.72 ? scored[0].entry : null;
}

function findBestMemoryMatch(source: string, query: string): ParsedMemoryEntry | null {
	const normalizedQuery = normalizeForCompare(query);
	const activeEntries = parseMemoryEntries(source).filter((entry) => entry.status === 'active');
	const direct = activeEntries.find((entry) => {
		const content = normalizeForCompare(entry.content);
		return content.includes(normalizedQuery) || normalizedQuery.includes(content);
	});
	if (direct) {
		return direct;
	}
	const scored = activeEntries
		.map((entry) => ({ entry, score: similarityScore(entry.content, query) }))
		.sort((left, right) => right.score - left.score);
	return scored[0] && scored[0].score >= 0.45 ? scored[0].entry : null;
}

function headingForScope(scope: MemoryScope): string {
	if (scope === 'environment') {
		return '## Environment';
	}
	if (scope === 'project' || scope === 'vaultpilot-ui') {
		return '## Project Facts';
	}
	if (scope === 'decision') {
		return '## Confirmed Decisions';
	}
	return '## Preferences';
}

function inferMemoryScope(content: string): MemoryScope {
	if (/\u51b3\u5b9a|\u786e\u8ba4|\u65b9\u6848|decision|decided|confirmed/iu.test(content)) {
		return 'decision';
	}
	if (/ui|\u754c\u9762|\u4ea4\u4e92|codex|process|tool/iu.test(content)) {
		return 'vaultpilot-ui';
	}
	if (/ollama|deepseek|api|model|embedding|\u6a21\u578b/iu.test(content)) {
		return 'environment';
	}
	if (/\u9879\u76ee|\u63d2\u4ef6|vaultpilot|obsidian/iu.test(content)) {
		return 'project';
	}
	return 'preference';
}

function similarityScore(left: string, right: string): number {
	const leftTokens = new Set(tokenizeForCompare(left));
	const rightTokens = new Set(tokenizeForCompare(right));
	if (leftTokens.size === 0 || rightTokens.size === 0) {
		return 0;
	}
	const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
	const union = new Set([...leftTokens, ...rightTokens]).size;
	const jaccard = intersection / union;
	const containment = intersection / Math.min(leftTokens.size, rightTokens.size);
	return Math.max(jaccard, containment);
}

function tokenizeForCompare(value: string): string[] {
	const normalized = normalizeForCompare(value);
	const ascii = normalized.match(/[a-z0-9_\-.]+/gu) ?? [];
	const cjk = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
	const cjkPairs = cjk.flatMap((token) => {
		if (token.length <= 3) {
			return [token];
		}
		const pairs: string[] = [];
		for (let index = 0; index < token.length - 1; index += 1) {
			pairs.push(token.slice(index, index + 2));
		}
		return [token, ...pairs];
	});
	return Array.from(new Set([...ascii, ...cjkPairs]));
}

function normalizeForCompare(value: string): string {
	return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function normalizeStatus(value: string | undefined): MemoryEntry['status'] {
	return value === 'archived' ? 'archived' : 'active';
}

function normalizeScope(value: string): MemoryScope {
	if (value === 'environment' || value === 'project' || value === 'decision' || value === 'vaultpilot-ui') {
		return value;
	}
	return 'preference';
}

function matchFirst(text: string, patterns: RegExp[]): string | null {
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		const value = match?.[1]?.trim();
		if (value) {
			return value;
		}
	}
	return null;
}

function createMemoryId(): string {
	return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${year}-${month}-${day}`;
}
