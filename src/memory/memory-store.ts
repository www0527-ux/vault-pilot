import { normalizePath, Vault } from 'obsidian';
import {
	forgetMemoryDocument,
	normalizeMemoryDocument,
	parseMemoryRequest,
	saveMemoryDocument,
	updateMemoryDocument,
} from './memory-document';
import type { MemoryRequest, MemorySaveResult } from './memory-document';

const MEMORY_PATH = normalizePath('VaultPilot/Memory.md');
const MEMORY_DIR = normalizePath('VaultPilot');

const DEFAULT_MEMORY = `# VaultPilot Memory

## Preferences

## Environment

## Project Facts

## Confirmed Decisions

## Archived
`;

export { parseMemoryRequest };
export type { MemoryRequest, MemorySaveResult };

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
		const current = await this.read();
		const result = saveMemoryDocument(current, content);
		if (result && result.updatedDocument !== current) {
			await this.vault.adapter.write(MEMORY_PATH, result.updatedDocument);
		}
		return result;
	}

	async update(query: string, content: string): Promise<MemorySaveResult | null> {
		const current = await this.read();
		const result = updateMemoryDocument(current, query, content);
		if (result && result.updatedDocument !== current) {
			await this.vault.adapter.write(MEMORY_PATH, result.updatedDocument);
		}
		return result;
	}

	async forget(query: string): Promise<number> {
		const current = await this.read();
		const result = forgetMemoryDocument(current, query);
		if (result.count > 0) {
			await this.vault.adapter.write(MEMORY_PATH, result.updatedDocument);
		}
		return result.count;
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
