import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceDir = path.join(repoRoot, '.datasets', 'sources', 'discrete-book', 'source');
const vaultRoot = 'D:\\期末复习\\期末复习';
const outputRoot = path.join(vaultRoot, '_rag_dataset', 'discrete-math-open-introduction');
const evalRoot = path.join(vaultRoot, '_rag_eval');

const chapterMap = new Map([
	['intro', { folder: '00-introduction', label: 'Introduction' }],
	['logic', { folder: '01-logic-and-proofs', label: 'Logic and proofs' }],
	['counting', { folder: '02-counting', label: 'Counting' }],
	['seq', { folder: '03-sequences', label: 'Sequences' }],
	['structures', { folder: '04-mathematical-structures', label: 'Mathematical structures' }],
	['gt', { folder: '05-graph-theory', label: 'Graph theory' }],
	['addtops', { folder: '06-additional-topics', label: 'Additional topics' }],
]);

async function main() {
	await rm(outputRoot, { recursive: true, force: true });
	await mkdir(outputRoot, { recursive: true });
	await mkdir(evalRoot, { recursive: true });

	const sourceFiles = (await readdir(sourceDir))
		.filter((file) => /^sec_.*\.ptx$/u.test(file))
		.sort();

	const converted = [];
	for (const file of sourceFiles) {
		const sourcePath = path.join(sourceDir, file);
		const xml = await readFile(sourcePath, 'utf8');
		const note = convertSection(file, xml);
		if (!note) {
			continue;
		}

		const chapter = chapterMap.get(note.chapterKey) ?? {
			folder: '99-other',
			label: note.chapterKey,
		};
		const folder = path.join(outputRoot, chapter.folder);
		await mkdir(folder, { recursive: true });

		const outputName = `${slugify(note.title || file.replace(/\.ptx$/u, ''))}.md`;
		const outputPath = path.join(folder, outputName);
		await writeFile(outputPath, renderMarkdown(note, chapter.label, file), 'utf8');
		converted.push({
			title: note.title,
			chapter: chapter.label,
			path: path.relative(vaultRoot, outputPath).replaceAll('\\', '/'),
			source: file,
		});
	}

	await writeFile(path.join(outputRoot, 'README.md'), renderDatasetReadme(converted), 'utf8');
	await writeFile(path.join(evalRoot, 'questions.md'), renderEvalQuestions(), 'utf8');
	await writeFile(path.join(evalRoot, 'results.md'), renderEvalResults(), 'utf8');

	console.log(`Converted ${converted.length} sections to ${outputRoot}`);
}

function convertSection(file, xml) {
	const rootId = xml.match(/<section[^>]*xml:id="([^"]+)"/u)?.[1] ?? file.replace(/\.ptx$/u, '');
	const chapterKey = file.replace(/^sec_/u, '').replace(/\.ptx$/u, '').split('-')[0] ?? 'other';
	const title = decodeEntities(xml.match(/<title>([\s\S]*?)<\/title>/u)?.[1]?.trim() ?? rootId);
	let body = xml;

	body = body.replace(/<\?xml[\s\S]*?\?>/gu, '');
	body = body.replace(/<!--[\s\S]*?-->/gu, '');
	body = body.replace(/<idx>[\s\S]*?<\/idx>/gu, '');
	body = body.replace(/<image[\s\S]*?<\/image>/gu, '\n\n[Image omitted.]\n\n');
	body = body.replace(/<latex-image>[\s\S]*?<\/latex-image>/gu, '');
	body = body.replace(/<sage[\s\S]*?<\/sage>/gu, '');
	body = body.replace(/<exercise[\s\S]*?<\/exercise>/gu, '');
	body = body.replace(/<webwork[\s\S]*?<\/webwork>/gu, '');
	body = body.replace(/<solutions[\s\S]*?<\/solutions>/gu, '');
	body = body.replace(/<objectives[\s\S]*?<\/objectives>/gu, '');
	body = body.replace(/<title>[\s\S]*?<\/title>/u, '');

	body = body.replace(/<subsection[^>]*>\s*<title>([\s\S]*?)<\/title>/gu, (_, sectionTitle) => {
		return `\n\n## ${cleanInline(sectionTitle)}\n\n`;
	});
	body = body.replace(/<subsubsection[^>]*>\s*<title>([\s\S]*?)<\/title>/gu, (_, sectionTitle) => {
		return `\n\n### ${cleanInline(sectionTitle)}\n\n`;
	});
	body = body.replace(/<(definition|theorem|proposition|lemma|corollary|example|investigation|activity|aside)[^>]*>\s*<title>([\s\S]*?)<\/title>/gu, (_, kind, blockTitle) => {
		return `\n\n### ${labelFor(kind)}: ${cleanInline(blockTitle)}\n\n`;
	});
	body = body.replace(/<(definition|theorem|proposition|lemma|corollary|example|investigation|activity|aside)[^>]*>/gu, (_, kind) => {
		return `\n\n### ${labelFor(kind)}\n\n`;
	});
	body = body.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/gu, (_, item) => {
		return `\n- ${cleanInline(item)}\n`;
	});
	body = body.replace(/<p>([\s\S]*?)<\/p>/gu, (_, paragraph) => {
		return `\n\n${cleanInline(paragraph)}\n\n`;
	});
	body = body.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gu, (_, quote) => {
		return quote
			.split(/\r?\n/u)
			.map((line) => cleanInline(line))
			.filter(Boolean)
			.map((line) => `> ${line}`)
			.join('\n');
	});
	body = body.replace(/<me>([\s\S]*?)<\/me>/gu, (_, math) => {
		return `\n\n$$\n${cleanInline(math)}\n$$\n\n`;
	});
	body = body.replace(/<m>([\s\S]*?)<\/m>/gu, (_, math) => `$${cleanInline(math)}$`);
	body = body.replace(/<[^>]+>/gu, ' ');
	body = decodeEntities(body);
	body = body
		.split(/\r?\n/u)
		.map((line) => line.replace(/[ \t]+/gu, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/gu, '\n\n')
		.trim();

	if (!body) {
		return null;
	}
	return { rootId, chapterKey, title, body };
}

function renderMarkdown(note, chapter, sourceFile) {
	return `---\nsource: "Discrete Mathematics: An Open Introduction"\nsource_file: "${sourceFile}"\nsource_id: "${note.rootId}"\nauthor: "Oscar Levin"\nlicense: "CC BY-SA 4.0"\ndataset: "dmoi"\nchapter: "${chapter}"\n---\n\n# ${note.title}\n\n${note.body}\n`;
}

function renderDatasetReadme(converted) {
	const lines = converted.map((note) => `- [[${note.path.replace(/\.md$/u, '')}|${note.title}]] (${note.chapter})`);
	return `# RAG dataset: Discrete Mathematics Open Introduction\n\nThis folder contains Markdown notes converted from the PreTeXt source files of *Discrete Mathematics: An Open Introduction* by Oscar Levin.\n\n- Source repository: https://github.com/oscarlevin/discrete-book\n- Original project site: https://discrete.openmathbooks.org/\n- License in the checked-out source repository: CC BY-SA 4.0\n- Conversion purpose: local VaultPilot RAG experiments inside Obsidian\n\n## Converted sections\n\n${lines.join('\n')}\n`;
}

function renderEvalQuestions() {
	return `# VaultPilot RAG evaluation questions\n\nUse these questions to compare whole-note search, chunk search, BM25, embeddings, hybrid retrieval, and rerank.\n\n| ID | Question | Expected source | Notes |\n| --- | --- | --- | --- |\n| Q01 | What makes a mathematical argument valid? | _rag_dataset/discrete-math-open-introduction/01-logic-and-proofs/mathematical-statements.md | Should retrieve the definition of argument/valid/sound. |\n| Q02 | What is the difference between an implication and its converse? | _rag_dataset/discrete-math-open-introduction/01-logic-and-proofs/implications.md | Good test for related but distinct logical terms. |\n| Q03 | How do you prove a statement by induction? | _rag_dataset/discrete-math-open-introduction/03-sequences/proof-by-induction.md | Should retrieve base case and inductive case. |\n| Q04 | How does the principle of inclusion and exclusion help count non-disjoint outcomes? | _rag_dataset/discrete-math-open-introduction/02-counting/non-disjoint-outcomes.md | Good for concept retrieval. |\n| Q05 | What is a graph in graph theory? | _rag_dataset/discrete-math-open-introduction/05-graph-theory/problems-and-definitions.md | Should retrieve graph terminology. |\n| Q06 | What is the Handshake Lemma? | _rag_dataset/discrete-math-open-introduction/05-graph-theory/problems-and-definitions.md | Tests whether retrieval can find a theorem inside a longer note. |\n| Q07 | What does it mean for a graph to be planar? | _rag_dataset/discrete-math-open-introduction/05-graph-theory/planar-graphs.md | Tests graph subtopic retrieval. |\n| Q08 | How are functions different from relations? | _rag_dataset/discrete-math-open-introduction/04-mathematical-structures/functions.md | May also retrieve relations; rerank should prefer functions. |\n| Q09 | What is a generating function? | _rag_dataset/discrete-math-open-introduction/06-additional-topics/generating-functions.md | Good later test for specialized vocabulary. |\n| Q10 | How does Pascal's triangle relate to binomial coefficients? | _rag_dataset/discrete-math-open-introduction/02-counting/pascal-s-arithmetical-triangle.md | Tests term variation and title matching. |\n\n## Manual scoring\n\nFor each run, record:\n\n- Top 5 retrieved notes/chunks\n- Whether the expected source is present in top 1, top 3, top 5\n- Whether the answer cites the expected source\n- Any hallucinated claim or missing condition\n`;
}

function renderEvalResults() {
	return `# VaultPilot RAG evaluation results\n\n| Date | Retrieval mode | Question ID | Top 1 correct | Expected in top 3 | Expected in top 5 | Notes |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
}

function labelFor(kind) {
	const labels = {
		activity: 'Activity',
		aside: 'Aside',
		corollary: 'Corollary',
		definition: 'Definition',
		example: 'Example',
		investigation: 'Investigation',
		lemma: 'Lemma',
		proposition: 'Proposition',
		theorem: 'Theorem',
	};
	return labels[kind] ?? kind;
}

function cleanInline(value) {
	return decodeEntities(value)
		.replace(/<em>([\s\S]*?)<\/em>/gu, '*$1*')
		.replace(/<term>([\s\S]*?)<\/term>/gu, '**$1**')
		.replace(/<q>([\s\S]*?)<\/q>/gu, '"$1"')
		.replace(/<m>([\s\S]*?)<\/m>/gu, '$$$1$')
		.replace(/<[^>]+>/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

function decodeEntities(value) {
	return value
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'");
}

function slugify(value) {
	return value
		.toLowerCase()
		.replace(/&/gu, ' and ')
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-|-$/gu, '')
		.slice(0, 80);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
