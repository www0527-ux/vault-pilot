import { TFile } from 'obsidian';
import { SearchResult } from './types';

export function buildLocalAnswer(question: string, results: SearchResult[], activeFile: TFile | null): string {
	if (results.length === 0) {
		return [
			'No reliable vault evidence was found for this question.',
			activeFile ? `Current note: [[${activeFile.basename}]].` : '',
			'Try a more specific concept, tag, file name, or heading.',
		]
			.filter(Boolean)
			.join('\n');
	}

	const sources = results
		.slice(0, 5)
		.map((result, index) => `${index + 1}. [[${result.file.basename}]] - ${result.excerpt}`)
		.join('\n');

	return [
		`Local search result for: ${question}`,
		'These are retrieval candidates, not a synthesized answer. Open the sources or configure a remote model for an answer grounded in these notes.',
		'Most relevant notes:',
		sources,
	].join('\n\n');
}
