import { App, TFile } from 'obsidian';
import { extractHeadings, extractWikiLinks } from '../rag/text';

export interface NoteSnapshot {
	path: string;
	basename: string;
	content: string;
	headings: string[];
	links: string[];
}

export class VaultNoteService {
	constructor(private app: App) {}

	getActiveMarkdownFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	async getCurrentNote(): Promise<NoteSnapshot | null> {
		const file = this.getActiveMarkdownFile();
		if (!file || file.extension !== 'md') {
			return null;
		}
		return this.readFile(file);
	}

	async readNote(path: string): Promise<NoteSnapshot> {
		const file = this.resolveMarkdownFile(path);
		if (!(file instanceof TFile) || file.extension !== 'md') {
			throw new Error(`Markdown note not found: ${path}`);
		}
		return this.readFile(file);
	}

	private resolveMarkdownFile(path: string): TFile | null {
		const normalized = normalizeVaultPath(path);
		const direct = this.app.vault.getAbstractFileByPath(normalized);
		if (direct instanceof TFile && direct.extension === 'md') {
			return direct;
		}

		const withoutMd = normalized.endsWith('.md') ? normalized.slice(0, -3) : normalized;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const filePath = file.path.replaceAll('\\', '/');
			if (
				normalized.endsWith(`/${filePath}`) ||
				withoutMd.endsWith(`/${filePath.slice(0, -3)}`)
			) {
				return file;
			}
		}
		return null;
	}

	private async readFile(file: TFile): Promise<NoteSnapshot> {
		const content = await this.app.vault.cachedRead(file);
		return {
			path: file.path,
			basename: file.basename,
			content,
			headings: extractHeadings(content),
			links: extractWikiLinks(content),
		};
	}
}

function normalizeVaultPath(path: string): string {
	return path.trim().replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}
