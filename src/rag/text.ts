export function tokenize(input: string): string[] {
	const tokens = new Set<string>();
	const segments = input
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);

	for (const segment of segments) {
		if (/[\u3400-\u9fff]/u.test(segment)) {
			tokens.add(segment);
			const chars = Array.from(segment);
			for (let index = 0; index < chars.length - 1; index += 1) {
				const first = chars[index];
				const second = chars[index + 1];
				if (first && second) {
					tokens.add(`${first}${second}`);
				}
			}
			continue;
		}

		if (isUsefulLatinToken(segment)) {
			tokens.add(segment);
		}
	}

	return Array.from(tokens).slice(0, 60);
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
}

export function extractHeadings(content: string): string[] {
	return content
		.split(/\r?\n/)
		.filter((line) => line.startsWith('#'))
		.map((line) => line.replace(/^#+\s*/, '').trim())
		.filter(Boolean);
}

export function extractWikiLinks(content: string): string[] {
	const links = new Set<string>();
	for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
		const target = match[1]?.trim();
		if (target) {
			links.add(target);
		}
	}
	return Array.from(links);
}

function isUsefulLatinToken(token: string): boolean {
	if (token.length < 3) {
		return false;
	}
	if (LATIN_STOP_WORDS.has(token)) {
		return false;
	}
	return /[a-z0-9]/u.test(token);
}

const LATIN_STOP_WORDS = new Set([
	'and',
	'are',
	'but',
	'can',
	'for',
	'from',
	'has',
	'have',
	'how',
	'its',
	'not',
	'that',
	'the',
	'this',
	'what',
	'when',
	'where',
	'which',
	'who',
	'why',
	'with',
]);
