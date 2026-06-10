import { normalizePath, Vault } from 'obsidian';

const MEMORY_PATH = normalizePath('VaultPilot/Memory.md');
const MEMORY_DIR = normalizePath('VaultPilot');

const DEFAULT_MEMORY = `# VaultPilot Memory

## Preferences

## Project Context

## Confirmed Decisions
`;

export class MemoryStore {
	constructor(private vault: Vault) {}

	getPath(): string {
		return MEMORY_PATH;
	}

	async read(): Promise<string> {
		await this.ensureFile();
		return this.vault.adapter.read(MEMORY_PATH);
	}

	async append(content: string): Promise<void> {
		const cleaned = content.trim();
		if (!cleaned) {
			return;
		}
		await this.ensureFile();
		const current = await this.vault.adapter.read(MEMORY_PATH);
		const entry = `\n- ${formatDate(new Date())}: ${cleaned}\n`;
		const updated = current.includes('## Preferences')
			? current.replace(/## Preferences\s*/u, (match) => `${match}${entry}`)
			: `${current.trim()}\n\n## Preferences\n${entry}`;
		await this.vault.adapter.write(MEMORY_PATH, updated);
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

export function parseMemoryRequest(question: string): string | null {
	const trimmed = question.trim();
	const patterns = [
		/^(?:请)?记住[:：,，\s]*(.+)$/u,
		/^remember(?: that)?[:：,，\s]+(.+)$/iu,
		/^save (?:this )?(?:memory|preference)[:：,，\s]+(.+)$/iu,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(trimmed);
		const value = match?.[1]?.trim();
		if (value) {
			return value;
		}
	}
	return null;
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${year}-${month}-${day}`;
}
