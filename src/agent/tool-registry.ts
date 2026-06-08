import { AgentTool, ToolDefinition } from './types';

export class ToolRegistry {
	private tools = new Map<string, AgentTool<unknown, unknown>>();

	register(tool: AgentTool<unknown, unknown>): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
		this.tools.set(tool.name, tool);
	}

	get(name: string): AgentTool<unknown, unknown> | undefined {
		return this.tools.get(name);
	}

	listDefinitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.schema,
			},
		}));
	}
}
