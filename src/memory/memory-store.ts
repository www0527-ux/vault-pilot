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

export type MemoryRequest =
	| { type: 'remember'; content: string }
	| { type: 'forget'; content: string };

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

	async append(content: string): Promise<void> {
		const cleaned = content.trim();
		if (!cleaned) {
			return;
		}
		const current = await this.read();
		const entry = formatMemoryEntry({
			id: createMemoryId(),
			status: 'active',
			scope: inferMemoryScope(cleaned),
			updated: formatDate(new Date()),
			content: cleaned,
		});
		await this.vault.adapter.write(MEMORY_PATH, insertUnderHeading(current, '## Preferences', entry));
	}

	async forget(query: string): Promise<number> {
		const cleaned = query.trim().toLowerCase();
		if (!cleaned) {
			return 0;
		}
		const current = await this.read();
		let count = 0;
		const updated = current.replace(
			/- id: ([^\n]+)\n[ ]{2}status: active\n[ ]{2}scope: ([^\n]+)\n[ ]{2}updated: ([^\n]+)\n[ ]{2}content: ([^\n]+)/gu,
			(match, id: string, scope: string, updatedAt: string, content: string) => {
				if (!content.toLowerCase().includes(cleaned)) {
					return match;
				}
				count += 1;
				return [
					`- id: ${id}`,
					'  status: archived',
					`  scope: ${scope}`,
					`  updated: ${updatedAt}`,
					`  archived: ${formatDate(new Date())}`,
					`  content: ${content}`,
				].join('\n');
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
		/^(?:\u8bf7)?\u8bb0\u4f4f[:\uff1a,，\s]*(.+)$/u,
		/^remember(?: that)?[:：,，\s]+(.+)$/iu,
		/^save (?:this )?(?:memory|preference)[:：,，\s]+(.+)$/iu,
	];
	const forgetPatterns = [
		/^(?:\u8bf7)?(?:\u5fd8\u8bb0|\u5220\u9664\u8bb0\u5fc6|\u79fb\u9664\u8bb0\u5fc6)[:\uff1a,，\s]*(.+)$/u,
		/^(?:forget|remove memory|delete memory)[:：,，\s]+(.+)$/iu,
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
	scope: string;
	updated: string;
	content: string;
}

function formatMemoryEntry(entry: MemoryEntry): string {
	return [
		`- id: ${entry.id}`,
		`  status: ${entry.status}`,
		`  scope: ${entry.scope}`,
		`  updated: ${entry.updated}`,
		`  content: ${entry.content}`,
		'',
	].join('\n');
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

function inferMemoryScope(content: string): string {
	if (/ui|界面|交互|codex|process|tool/iu.test(content)) {
		return 'vaultpilot-ui';
	}
	if (/ollama|deepseek|api|model|embedding|模型/u.test(content)) {
		return 'environment';
	}
	if (/项目|插件|vaultpilot|obsidian/iu.test(content)) {
		return 'project';
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
