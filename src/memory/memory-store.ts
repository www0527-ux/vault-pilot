import { normalizePath, Vault } from 'obsidian';

const MEMORY_PATH = normalizePath('VaultPilot/Memory.md');
const MEMORY_DIR = normalizePath('VaultPilot');

const DEFAULT_MEMORY = `# VaultPilot Memory

## Preferences

## Environment

## Project Facts

## Confirmed Decisions

## Archived
`;

const MEMORY_ENTRY_PATTERN = /- id: ([^\n]+)\n[ ]{2}status: (active|archived)\n[ ]{2}scope: ([^\n]+)\n[ ]{2}updated: ([^\n]+)(?:\n[ ]{2}archived: ([^\n]+))?\n[ ]{2}content: ([^\n]+)/gu;

type MemoryScope = 'preference' | 'environment' | 'project' | 'decision' | 'vaultpilot-ui';

export type MemoryRequest =
	| { type: 'remember'; content: string }
	| { type: 'forget'; content: string };

export interface MemorySaveResult {
	action: 'created' | 'updated' | 'unchanged';
	id: string;
	scope: MemoryScope;
	content: string;
	previousContent?: string;
}

interface ParsedMemoryEntry extends MemoryEntry {
	archived?: string;
	raw: string;
}

export class MemoryStore {
	constructor(private vault: Vault) {}

	getPath(): string {
		return MEMORY_PATH;
	}

	async read(): Promise<string> {
		await this.ensureFile();
		const current = await this.vault.adapter.read(MEMORY_PATH);
		const normalized = normalizeMemoryDocument(current);
		if (normalized !== current) {
			await this.vault.adapter.write(MEMORY_PATH, normalized);
		}
		return normalized;
	}

	async append(content: string): Promise<MemorySaveResult | null> {
		const cleaned = content.trim();
		if (!cleaned) {
			return null;
		}
		const current = await this.read();
		const scope = inferMemoryScope(cleaned);
		const existing = findReusableMemory(current, cleaned, scope);
		if (existing && normalizeForCompare(existing.content) === normalizeForCompare(cleaned)) {
			return {
				action: 'unchanged',
				id: existing.id,
				scope: existing.scope,
				content: existing.content,
			};
		}
		if (existing) {
			const updated: MemoryEntry = {
				id: existing.id,
				status: 'active',
				scope,
				updated: formatDate(new Date()),
				content: cleaned,
			};
			await this.vault.adapter.write(MEMORY_PATH, replaceMemoryEntry(current, existing, updated));
			return {
				action: 'updated',
				id: existing.id,
				scope,
				content: cleaned,
				previousContent: existing.content,
			};
		}
		const entry: MemoryEntry = {
			id: createMemoryId(),
			status: 'active',
			scope,
			updated: formatDate(new Date()),
			content: cleaned,
		};
		await this.vault.adapter.write(MEMORY_PATH, insertUnderHeading(current, headingForScope(scope), formatMemoryEntry(entry)));
		return {
			action: 'created',
			id: entry.id,
			scope,
			content: cleaned,
		};
	}

	async update(query: string, content: string): Promise<MemorySaveResult | null> {
		const cleanedQuery = query.trim();
		const cleanedContent = content.trim();
		if (!cleanedQuery || !cleanedContent) {
			return null;
		}
		const current = await this.read();
		const existing = findBestMemoryMatch(current, cleanedQuery);
		if (!existing) {
			return null;
		}
		const scope = inferMemoryScope(cleanedContent);
		const updated: MemoryEntry = {
			id: existing.id,
			status: 'active',
			scope,
			updated: formatDate(new Date()),
			content: cleanedContent,
		};
		await this.vault.adapter.write(MEMORY_PATH, replaceMemoryEntry(current, existing, updated));
		return {
			action: 'updated',
			id: existing.id,
			scope,
			content: cleanedContent,
			previousContent: existing.content,
		};
	}

	async forget(query: string): Promise<number> {
		const cleaned = query.trim().toLowerCase();
		if (!cleaned) {
			return 0;
		}
		const current = await this.read();
		let count = 0;
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
					archived: formatDate(new Date()),
					content,
				}).trimEnd();
			},
		);
		if (count > 0) {
			await this.vault.adapter.write(MEMORY_PATH, updated);
		}
		return count;
	}

	private async ensureFile(): Promise<void> {
		if (!(await this.vault.adapter.exists(MEMORY_DIR))) {
			await this.vault.adapter.mkdir(MEMORY_DIR);
		}
		if (!(await this.vault.adapter.exists(MEMORY_PATH))) {
			await this.vault.adapter.write(MEMORY_PATH, DEFAULT_MEMORY);
		}
	}
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

interface MemoryEntry {
	id: string;
	status: 'active' | 'archived';
	scope: MemoryScope;
	updated: string;
	archived?: string;
	content: string;
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

function normalizeMemoryDocument(content: string): string {
	const lines = content.trim() ? content.trim().split(/\r?\n/u) : ['# VaultPilot Memory'];
	let normalized = lines.join('\n');
	for (const heading of ['## Preferences', '## Environment', '## Project Facts', '## Confirmed Decisions', '## Archived']) {
		if (!normalized.includes(heading)) {
			normalized = `${normalized.trim()}\n\n${heading}\n`;
		}
	}
	return `${normalized.trim()}\n`;
}

function insertUnderHeading(document: string, heading: string, entry: string): string {
	const index = document.indexOf(heading);
	if (index === -1) {
		return `${document.trim()}\n\n${heading}\n${entry}`;
	}
	const insertAt = index + heading.length;
	return `${document.slice(0, insertAt)}\n${entry}${document.slice(insertAt).replace(/^\s*/u, '\n')}`;
}

function replaceMemoryEntry(document: string, existing: ParsedMemoryEntry, updated: MemoryEntry): string {
	const withoutExisting = document.replace(existing.raw, '').replace(/\n{3,}/gu, '\n\n');
	return insertUnderHeading(withoutExisting, headingForScope(updated.scope), formatMemoryEntry(updated));
}

function parseMemoryEntries(document: string): ParsedMemoryEntry[] {
	return Array.from(document.matchAll(MEMORY_ENTRY_PATTERN)).map((match) => ({
		id: match[1] ?? '',
		status: normalizeStatus(match[2]),
		scope: normalizeScope(match[3] ?? ''),
		updated: match[4] ?? '',
		archived: match[5],
		content: match[6] ?? '',
		raw: match[0] ?? '',
	}));
}

function findReusableMemory(document: string, content: string, scope: MemoryScope): ParsedMemoryEntry | null {
	const activeEntries = parseMemoryEntries(document).filter((entry) => entry.status === 'active');
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

function findBestMemoryMatch(document: string, query: string): ParsedMemoryEntry | null {
	const normalizedQuery = normalizeForCompare(query);
	const activeEntries = parseMemoryEntries(document).filter((entry) => entry.status === 'active');
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
	return intersection / union;
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
