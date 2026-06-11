export type ContextRoute = 'follow_up' | 'new_topic' | 'memory_recall' | 'correction';

export interface ContextRouteDecision {
	route: ContextRoute;
	reason: string;
	includeSummary: boolean;
	includeSlidingWindow: boolean;
	includePastThreads: boolean;
}

const FOLLOW_UP_PATTERNS = [
	/\b(it|this|that|these|those|they|them|same|above|previous|continue|more|second|third)\b/iu,
	/继续|接着|刚才|上面|前面|这个|那个|它|他们|它们|其中|第二点|第三点|再说|展开|详细/u,
];

const MEMORY_RECALL_PATTERNS = [
	/之前|以前|上次|早些时候|还记得|我们说过|聊过|历史|回顾|很早|过去/u,
	/\b(previously|earlier|last time|remember when|we discussed|we talked about|history|older|past)\b/iu,
];

const CORRECTION_PATTERNS = [
	/不是|不对|纠正|更正|改成|应该是|我不是这个意思|你理解错/u,
	/\b(no|not that|correction|actually|instead|change it to|you misunderstood)\b/iu,
];

export function routeConversationContext(question: string): ContextRouteDecision {
	const normalized = question.trim();
	if (matchesAny(normalized, CORRECTION_PATTERNS)) {
		return {
			route: 'correction',
			reason: 'The user appears to be correcting or revising previous context.',
			includeSummary: true,
			includeSlidingWindow: true,
			includePastThreads: false,
		};
	}
	if (matchesAny(normalized, MEMORY_RECALL_PATTERNS)) {
		return {
			route: 'memory_recall',
			reason: 'The user is explicitly referring to earlier discussion or memory.',
			includeSummary: true,
			includeSlidingWindow: true,
			includePastThreads: true,
		};
	}
	if (matchesAny(normalized, FOLLOW_UP_PATTERNS) && !looksLikeStandaloneTopic(normalized)) {
		return {
			route: 'follow_up',
			reason: 'The question uses follow-up references without a clear standalone topic.',
			includeSummary: true,
			includeSlidingWindow: true,
			includePastThreads: false,
		};
	}
	return {
		route: 'new_topic',
		reason: 'The question appears to introduce a standalone topic.',
		includeSummary: false,
		includeSlidingWindow: false,
		includePastThreads: false,
	};
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function looksLikeStandaloneTopic(text: string): boolean {
	if (/[?？]$/u.test(text) && text.length > 14) {
		return true;
	}
	if (/\b(about|explain|summarize|compare|search|find|what is|who is)\b/iu.test(text)) {
		return true;
	}
	return /关于|介绍|总结|搜索|查找|比较|是什么|是谁|有哪些/u.test(text);
}
