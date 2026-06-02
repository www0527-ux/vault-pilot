import { TFile } from 'obsidian';
import { NoteChunk } from './types';
import { stripFrontmatter } from './text';

const MAX_CHUNK_CHARS = 1800;

interface HeadingState {
	level: number;
	text: string;
}

export function chunkMarkdownNote(file: TFile, content: string): NoteChunk[] {
	const markdown = stripFrontmatter(content);
	const lines = markdown.split(/\r?\n/);
	const chunks: NoteChunk[] = [];
	const headings: HeadingState[] = [];
	let current: {
		title: string;
		headingPath: string[];
		startLine: number;
		lines: string[];
	} | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		const heading = parseHeading(line);

		if (heading) {
			flushCurrent(file, chunks, current, index);
			while (headings.length > 0 && (headings.at(-1)?.level ?? 0) >= heading.level) {
				headings.pop();
			}
			headings.push(heading);
			current = {
				title: heading.text,
				headingPath: headings.map((item) => item.text),
				startLine: index + 1,
				lines: [line],
			};
			continue;
		}

		if (!current) {
			current = {
				title: file.basename,
				headingPath: [file.basename],
				startLine: index + 1,
				lines: [],
			};
		}
		current.lines.push(line);
	}

	flushCurrent(file, chunks, current, lines.length);
	return chunks;
}

function flushCurrent(
	file: TFile,
	chunks: NoteChunk[],
	current: {
		title: string;
		headingPath: string[];
		startLine: number;
		lines: string[];
	} | null,
	endLine: number,
) {
	if (!current) {
		return;
	}

	const content = current.lines.join('\n').trim();
	if (!content) {
		return;
	}

	const trimmedContent =
		content.length > MAX_CHUNK_CHARS
			? `${content.slice(0, MAX_CHUNK_CHARS - 3).trimEnd()}...`
			: content;

	const id = `${file.path}#L${current.startLine}-L${endLine}`;
	chunks.push({
		id,
		file,
		title: current.title,
		headingPath: current.headingPath,
		content: trimmedContent,
		contextText: buildChunkContext(file, current.headingPath),
		startLine: current.startLine,
		endLine,
	});
}

function buildChunkContext(file: TFile, headingPath: string[]): string {
	return [
		`File: ${file.path}`,
		`Note title: ${file.basename}`,
		headingPath.length > 0 ? `Section: ${headingPath.join(' > ')}` : '',
	]
		.filter(Boolean)
		.join('\n');
}

function parseHeading(line: string): HeadingState | null {
	const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/u.exec(line);
	if (!match) {
		return null;
	}
	const marker = match[1];
	const text = match[2]?.trim();
	if (!marker || !text) {
		return null;
	}
	return { level: marker.length, text };
}
