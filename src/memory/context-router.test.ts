import assert from 'node:assert/strict';
import test from 'node:test';
import { routeConversationContext } from './context-router';

test('standalone new topics do not inject thread context', () => {
	const route = routeConversationContext('给我讲讲有关电影的笔记');
	assert.equal(route.route, 'new_topic');
	assert.equal(route.includeSummary, false);
	assert.equal(route.includeSlidingWindow, false);
	assert.equal(route.includePastThreads, false);
});

test('follow-up references keep current thread context', () => {
	const route = routeConversationContext('继续展开第二点');
	assert.equal(route.route, 'follow_up');
	assert.equal(route.includeSummary, true);
	assert.equal(route.includeSlidingWindow, true);
	assert.equal(route.includePastThreads, false);
});

test('explicit memory recall searches past threads', () => {
	const route = routeConversationContext('你还记得我们很早之前讨论过的记忆方案吗？');
	assert.equal(route.route, 'memory_recall');
	assert.equal(route.includeSummary, true);
	assert.equal(route.includeSlidingWindow, true);
	assert.equal(route.includePastThreads, true);
});

test('corrections stay in current thread but do not search old threads', () => {
	const route = routeConversationContext('不对，我刚才不是这个意思');
	assert.equal(route.route, 'correction');
	assert.equal(route.includeSummary, true);
	assert.equal(route.includeSlidingWindow, true);
	assert.equal(route.includePastThreads, false);
});
