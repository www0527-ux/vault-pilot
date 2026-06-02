import { TFile } from 'obsidian';
import { SearchResult } from './types';

export function buildLocalAnswer(question: string, results: SearchResult[], activeFile: TFile | null): string {
	if (results.length === 0) {
		return [
			'本地检索没有找到足够相关的笔记。',
			activeFile ? `当前笔记：[[${activeFile.basename}]]。` : '',
			'可以换成更具体的概念、标签、文件名或标题再问一次。',
		]
			.filter(Boolean)
			.join('\n');
	}

	const sources = results
		.slice(0, 5)
		.map((result, index) => `${index + 1}. [[${result.file.basename}]] - ${result.excerpt}`)
		.join('\n');

	return [
		`当前是本地检索结果，还不是大模型回答。检索问题：${question}`,
		'最相关的笔记：',
		sources,
		'下一步建议：如果你已经配置 DeepSeek，请确认 Answer mode 是 OpenAI-compatible；如果远程调用失败，VaultPilot 会在这里显示失败原因。',
	].join('\n\n');
}
