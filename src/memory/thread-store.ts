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
