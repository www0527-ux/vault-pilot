import { normalizePath, Vault } from 'obsidian';

const THREADS_DIR = normalizePath('VaultPilot/Threads');
const THREAD_ID_RANDOM_LENGTH = 6;

export type ThreadEvent =
	| { type: 'user'; content: string }
	| { type: 'assistant'; content: string }
	| { type: 'process'; content: string }
	| { type: 'tool_start'; name: string; inputSummary: string }
	| { type: 'tool_result'; name: string; ok: boolean; summary: string; durationMs: number; error?: string };

interface ThreadMetadata {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: 'active' | 'archived';
	eventCount: number;
}

export class ThreadStore {
	private queues = new Map<string, Promise<void>>();

	constructor(private vault: Vault) {}

	async createThread(initialTitle: string): Promise<string> {
		await this.ensureDirectory(THREADS_DIR);
		const now = new Date().toISOString();
		const id = `${formatCompactDate(new Date())}-${randomId()}`;
		const directory = this.threadDirectory(id);
		await this.ensureDirectory(directory);
		const metadata: ThreadMetadata = {
			id,
			title: titleFromPrompt(initialTitle),
			createdAt: now,
			updatedAt: now,
			status: 'active',
			eventCount: 0,
		};
		await this.vault.adapter.write(this.metadataPath(id), JSON.stringify(metadata, null, 2));
		await this.vault.adapter.write(this.transcriptPath(id), '');
		await this.vault.adapter.write(this.summaryPath(id), buildInitialSummary(metadata));
		return id;
	}

	appendEvent(threadId: string, event: ThreadEvent): Promise<void> {
		const queued = (this.queues.get(threadId) ?? Promise.resolve())
			.then(() => this.writeEvent(threadId, event))
			.catch((error) => {
				console.debug('VaultPilot thread event write failed.', error);
			});
		this.queues.set(threadId, queued);
		return queued;
	}

	async readSummary(threadId: string): Promise<string> {
		return this.vault.adapter.read(this.summaryPath(threadId));
	}

	updateSummary(threadId: string): Promise<void> {
		const queued = (this.queues.get(threadId) ?? Promise.resolve())
			.then(() => this.writeSummary(threadId))
			.catch((error) => {
				console.debug('VaultPilot thread summary update failed.', error);
			});
		this.queues.set(threadId, queued);
		return queued;
	}

	private async writeEvent(threadId: string, event: ThreadEvent): Promise<void> {
		const timestamp = new Date().toISOString();
		const payload = { time: timestamp, ...event };
		await this.vault.adapter.append(this.transcriptPath(threadId), `${JSON.stringify(payload)}\n`);
		await this.updateMetadata(threadId, timestamp);
	}

	private async updateMetadata(threadId: string, updatedAt: string): Promise<void> {
		const path = this.metadataPath(threadId);
		const raw = await this.vault.adapter.read(path);
		const metadata = JSON.parse(raw) as ThreadMetadata;
		metadata.updatedAt = updatedAt;
		metadata.eventCount += 1;
		await this.vault.adapter.write(path, JSON.stringify(metadata, null, 2));
	}

	private async writeSummary(threadId: string): Promise<void> {
		const metadata = JSON.parse(await this.vault.adapter.read(this.metadataPath(threadId))) as ThreadMetadata;
		const events = parseTranscript(await this.vault.adapter.read(this.transcriptPath(threadId)));
		const summary = buildRollingSummary(metadata, events);
		await this.vault.adapter.write(this.summaryPath(threadId), summary);
	}

	private async ensureDirectory(path: string): Promise<void> {
		if (!(await this.vault.adapter.exists(path))) {
			await this.vault.adapter.mkdir(path);
		}
	}

	private threadDirectory(threadId: string): string {
		return normalizePath(`${THREADS_DIR}/${threadId}`);
	}

	private metadataPath(threadId: string): string {
		return normalizePath(`${this.threadDirectory(threadId)}/metadata.json`);
	}

	private transcriptPath(threadId: string): string {
		return normalizePath(`${this.threadDirectory(threadId)}/transcript.jsonl`);
	}

	private summaryPath(threadId: string): string {
		return normalizePath(`${this.threadDirectory(threadId)}/summary.md`);
	}
}

function buildInitialSummary(metadata: ThreadMetadata): string {
	return [
		`# ${metadata.title}`,
		'',
		'## Current Topic',
		'',
		'## User Goals',
		'',
		'## Decisions',
		'',
		'## Open Questions',
		'',
	].join('\n');
}

function buildRollingSummary(metadata: ThreadMetadata, events: Array<ThreadEvent & { time: string }>): string {
	const userEvents = events.filter((event) => event.type === 'user');
	const assistantEvents = events.filter((event) => event.type === 'assistant');
	const toolResults = events.filter((event) => event.type === 'tool_result');
	const processEvents = events.filter((event) => event.type === 'process');
	const recentTurns = buildRecentTurns(events).slice(-4);
	const currentTopic = summarizeText(userEvents.at(-1)?.content ?? metadata.title, 180);
	const lastAssistant = summarizeText(assistantEvents.at(-1)?.content ?? '', 360);
	return [
		`# ${metadata.title}`,
		'',
		'## Metadata',
		`- Thread id: ${metadata.id}`,
		`- Created: ${metadata.createdAt}`,
		`- Updated: ${metadata.updatedAt}`,
		`- Events: ${metadata.eventCount}`,
		'',
		'## Current Topic',
		currentTopic ? `- ${currentTopic}` : '- Unknown',
		'',
		'## Recent User Goals',
		...formatBullets(userEvents.slice(-5).map((event) => summarizeText(event.content, 180))),
		'',
		'## Recent Assistant State',
		lastAssistant ? `- ${lastAssistant}` : '- No assistant answer yet.',
		'',
		'## Recent Process Notes',
		...formatBullets(processEvents.slice(-4).map((event) => summarizeText(event.content, 180))),
		'',
		'## Tool Activity',
		...formatBullets(toolResults.slice(-8).map(formatToolResult)),
		'',
		'## Recent Turns',
		...recentTurns.flatMap(formatTurn),
		'',
		'## Open Questions',
		'- Not yet summarized.',
		'',
	].join('\n');
}

function parseTranscript(raw: string): Array<ThreadEvent & { time: string }> {
	return raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const parsed = JSON.parse(line) as ThreadEvent & { time?: string };
				return parsed.time ? [{ ...parsed, time: parsed.time }] : [];
			} catch {
				return [];
			}
		});
}

function buildRecentTurns(events: Array<ThreadEvent & { time: string }>): ConversationSummaryTurn[] {
	const turns: ConversationSummaryTurn[] = [];
	let current: ConversationSummaryTurn | null = null;
	for (const event of events) {
		if (event.type === 'user') {
			current = { user: event.content, assistant: '', time: event.time };
			turns.push(current);
			continue;
		}
		if (event.type === 'assistant' && current) {
			current.assistant = event.content;
		}
	}
	return turns;
}

interface ConversationSummaryTurn {
	user: string;
	assistant: string;
	time: string;
}

function formatTurn(turn: ConversationSummaryTurn): string[] {
	return [
		`### ${turn.time}`,
		`- User: ${summarizeText(turn.user, 220)}`,
		`- Assistant: ${summarizeText(turn.assistant, 320) || '(no final answer recorded)'}`,
	];
}

function formatToolResult(event: ThreadEvent & { time: string }): string {
	if (event.type !== 'tool_result') {
		return '';
	}
	const status = event.ok ? 'ok' : 'failed';
	const duration = `${event.durationMs}ms`;
	const error = event.error ? `; error: ${event.error}` : '';
	return `${event.name} ${status} (${duration}): ${summarizeText(event.summary, 180)}${error}`;
}

function formatBullets(values: string[]): string[] {
	const filtered = values.map((value) => value.trim()).filter(Boolean);
	return filtered.length > 0 ? filtered.map((value) => `- ${value}`) : ['- None yet.'];
}

function summarizeText(text: string, maxLength: number): string {
	const cleaned = text.replace(/\s+/gu, ' ').trim();
	if (cleaned.length <= maxLength) {
		return cleaned;
	}
	return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
}

function titleFromPrompt(prompt: string): string {
	const cleaned = prompt.replace(/\s+/gu, ' ').trim();
	if (!cleaned) {
		return 'Untitled VaultPilot thread';
	}
	return cleaned.length > 48 ? `${cleaned.slice(0, 48)}...` : cleaned;
}

function formatCompactDate(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	const hour = `${date.getHours()}`.padStart(2, '0');
	const minute = `${date.getMinutes()}`.padStart(2, '0');
	const second = `${date.getSeconds()}`.padStart(2, '0');
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 2 + THREAD_ID_RANDOM_LENGTH);
}
