import { TFile, Vault } from 'obsidian';
import { searchChunksWithBm25 } from './bm25';
import { chunkMarkdownNote } from './chunker';
import { SearchResult } from './types';
import { extractHeadings, extractWikiLinks, stripFrontmatter, tokenize } from './text';

export async function searchNotes(vault: Vault, query: string, limit: number): Promise<SearchResult[]> {
	const tokens = tokenize(query);
	if (tokens.length === 0) {
		return [];
	}

	const files = vault.getMarkdownFiles();
	const chunksByFile = await Promise.all(
		files.map(async (file) => {
			const content = await vault.cachedRead(file);
			return chunkMarkdownNote(file, content);
		}),
	);

	return searchChunksWithBm25(chunksByFile.flat(), tokens, limit);
}

export async function suggestLinks(
	vault: Vault,
	file: TFile,
	maxResults: number,
	search: (query: string, limit: number) => Promise<SearchResult[]>,
): Promise<SearchResult[]> {
	const content = await vault.cachedRead(file);
	const searchableContent = stripFrontmatter(content);
	const existingLinks = new Set(extractWikiLinks(searchableContent));
	const query = `${file.basename} ${extractHeadings(searchableContent).join(' ')} ${searchableContent.slice(0, 1200)}`;
	const results = await search(query, maxResults + 5);

	return results
		.filter((result) => result.file.path !== file.path)
		.filter((result) => !existingLinks.has(result.file.basename) && !existingLinks.has(result.file.path))
		.slice(0, maxResults);
}
