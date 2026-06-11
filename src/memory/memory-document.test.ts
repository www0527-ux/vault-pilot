import assert from 'node:assert/strict';
import test from 'node:test';
import {
	forgetMemoryDocument,
	normalizeMemoryDocument,
	parseMemoryRequest,
	saveMemoryDocument,
	updateMemoryDocument,
} from './memory-document';

const BASE_MEMORY = normalizeMemoryDocument(`# VaultPilot Memory

## Preferences

## Environment

## Project Facts

## Confirmed Decisions

## Archived
`);

test('routes saved memories into scoped sections', () => {
	const saved = saveMemoryDocument(BASE_MEMORY, 'DeepSeek API is the preferred remote model.', new Date('2026-06-11'), () => 'mem-env');
	assert.equal(saved?.action, 'created');
	assert.equal(saved?.scope, 'environment');
	assert.match(saved?.updatedDocument ?? '', /## Environment\n- id: mem-env/u);
	assert.match(saved?.updatedDocument ?? '', /content: DeepSeek API is the preferred remote model\./u);
});

test('deduplicates exact memories', () => {
	const first = saveMemoryDocument(BASE_MEMORY, 'Prefer concise Chinese answers.', new Date('2026-06-11'), () => 'mem-pref');
	assert.ok(first);
	const second = saveMemoryDocument(first.updatedDocument, 'Prefer concise Chinese answers.', new Date('2026-06-12'), () => 'mem-duplicate');
	assert.equal(second?.action, 'unchanged');
	assert.equal(second?.id, 'mem-pref');
	assert.doesNotMatch(second?.updatedDocument ?? '', /mem-duplicate/u);
});

test('updates similar scoped memories instead of appending duplicates', () => {
	const first = saveMemoryDocument(BASE_MEMORY, 'VaultPilot UI should feel like Codex process panels.', new Date('2026-06-11'), () => 'mem-ui');
	assert.ok(first);
	const second = saveMemoryDocument(first.updatedDocument, 'VaultPilot UI should feel like Codex process panels, with compact collapsed state.', new Date('2026-06-12'), () => 'mem-new');
	assert.equal(second?.action, 'updated');
	assert.equal(second?.id, 'mem-ui');
	assert.match(second?.updatedDocument ?? '', /compact collapsed state/u);
	assert.doesNotMatch(second?.updatedDocument ?? '', /mem-new/u);
});

test('updates an identified memory by query', () => {
	const first = saveMemoryDocument(BASE_MEMORY, 'Use Ollama for local embeddings.', new Date('2026-06-11'), () => 'mem-ollama');
	assert.ok(first);
	const updated = updateMemoryDocument(first.updatedDocument, 'Ollama', 'Use DeepSeek API for chat and Ollama only for local embeddings.', new Date('2026-06-12'));
	assert.equal(updated?.action, 'updated');
	assert.equal(updated?.id, 'mem-ollama');
	assert.match(updated?.updatedDocument ?? '', /Use DeepSeek API for chat/u);
});

test('archives matching active memories without deleting them', () => {
	const first = saveMemoryDocument(BASE_MEMORY, 'Remember the temporary test preference.', new Date('2026-06-11'), () => 'mem-temp');
	assert.ok(first);
	const forgotten = forgetMemoryDocument(first.updatedDocument, 'temporary test', new Date('2026-06-12'));
	assert.equal(forgotten.count, 1);
	assert.match(forgotten.updatedDocument, /status: archived/u);
	assert.match(forgotten.updatedDocument, /archived: 2026-06-12/u);
	assert.match(forgotten.updatedDocument, /content: Remember the temporary test preference\./u);
});

test('parses explicit remember and forget requests', () => {
	assert.deepEqual(parseMemoryRequest('记住：我喜欢简洁的 UI'), {
		type: 'remember',
		content: '我喜欢简洁的 UI',
	});
	assert.deepEqual(parseMemoryRequest('forget temporary test'), {
		type: 'forget',
		content: 'temporary test',
	});
});

