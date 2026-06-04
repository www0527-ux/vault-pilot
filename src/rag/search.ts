import { TFile, Vault } from 'obsidian';
import { SearchResult } from './types';
import { extractHeadings, extractWikiLinks, stripFrontmatter } from './text';

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
