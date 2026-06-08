# Tool Calling Streaming Failure Notes

This note records the failed streaming experiments around VaultPilot tool calling. It is written for future AI/code agents so they do not repeat the same implementation mistakes.

## Current Stable Baseline

The safe baseline is:

```text
model request with tools
-> structured tool_calls
-> execute tools
-> append tool results
-> repeat model request with tools
-> final answer when no tool_calls are returned
```

The agent runner must keep the tool loop active until the model returns a normal assistant message with no tool calls.

Do not switch to a tools-free streaming request immediately after the first tool result. The model may still need another tool, such as `read_note` after `search_notes`.

## What Went Wrong

### Failure 1: Premature Final Streaming

The broken flow was:

```text
model request with tools
-> search_notes tool_call
-> execute search_notes
-> append search result
-> start a normal streaming chat request without tools
```

This looked attractive because it restored token-level answer streaming. But it changed the contract: after `search_notes`, the model often wanted to call `read_note`. Because the follow-up streaming request did not include tools, the model could not emit a structured tool call.

Result: the model wrote a pseudo tool call in the visible answer text.

Example leaked text:

```text
<|DSML| tool_calls>
<|DSML| invoke name="read_note">
<|DSML| parameter name="path" string="true">...</|DSML| parameter>
</|DSML| invoke>
</|DSML| tool_calls>
```

Root cause:

```text
The runner treated "after one tool" as "ready for final answer".
```

Correct rule:

```text
Only the model can decide final answer readiness, and it must do so in a request where tools are still available.
```

### Failure 2: Parsing Text Tool Markup Instead Of Fixing The Loop

An attempted patch tried to parse DSML-like text from `message.content` and convert it into tool calls.

This was the wrong primary fix.

Reasons:

- It treats provider/model leakage as a normal protocol.
- It is fragile across providers and prompt formats.
- It masks the real loop bug.
- It can still leak if the model uses a slightly different pseudo-tool syntax.
- It encourages code to depend on undocumented model-internal markup.

The adapter may defensively reject obvious tool markup in visible content, but it should not rely on DSML parsing as the main control path.

Correct defensive behavior:

```text
if final assistant content appears to contain tool-call markup:
  treat it as provider/model protocol failure
  fallback to the fixed RAG path or show a safe error
  never render the markup as the answer
```

### Failure 3: Tool Lifecycle Streaming Was Confused With Tool-Call Streaming

There are three different kinds of streaming:

```text
1. Answer token streaming
2. User-facing process/status streaming
3. Structured tool-call delta streaming
```

The failed experiment mixed these together.

Tool lifecycle streaming is safe:

```text
Choosing tools
Running search_notes
search_notes returned 5 results
Reviewing tool results
Writing answer
```

Structured tool-call delta streaming is harder:

```text
streaming chunks include partial tool_calls
arguments arrive as partial JSON strings
the runner buffers them
the runner executes tools only after finish_reason/tool_calls completion
```

Do not fake structured tool-call delta streaming by starting a normal text stream without tools.

## Required Runner Invariant

`AgentRunner` must maintain this invariant:

```text
Every model turn before final answer must include tool definitions.
```

Pseudocode:

```ts
for (let step = 0; step < maxSteps; step += 1) {
	const response = await completeChatWithTools(messages, tools);

	if (response.toolCalls.length === 0) {
		return response.answer;
	}

	messages.push(response.assistantToolCallMessage);

	for (const call of response.toolCalls) {
		const result = await executor.execute(call, context);
		messages.push(toToolResultMessage(call, result));
	}
}

throw new Error('Tool step limit reached');
```

The final answer can be non-streaming in V1. Correctness is more important than token streaming.

## Safe Path To Reintroduce Streaming

### Step 1: Keep Non-Streaming Tool Decisions

Use non-streaming requests for tool decisions:

```text
completeChatWithTools(..., stream: false)
```

Then stream only user-facing process events from the runner:

```text
Choosing tools
Running search_notes
Running read_note
Writing answer
```

This gives users live feedback without touching provider-specific streaming tool-call parsing.

### Step 2: Stream Final Answer Only After A No-Tool Turn

A safe but slightly redundant option:

```text
model request with tools -> no tool_calls, returns final answer plan/content
then optionally make a second answer-only streaming request using the same gathered evidence
```

Downside: this can cost an extra model call and may produce answer drift.

If this path is used, the second request must explicitly forbid tool calls and include enough evidence. It should be treated as answer rendering, not agent reasoning.

### Step 3: True Streaming Tool Calls

True streaming tool calling requires a dedicated parser for provider streaming chunks.

Needed behavior:

- Read SSE chunks.
- Accumulate `delta.tool_calls[index].function.name`.
- Accumulate partial `delta.tool_calls[index].function.arguments`.
- Wait for the provider finish signal.
- Parse the completed arguments.
- Execute tools.
- Continue the loop.
- Only render `delta.content` as answer after no tool calls are active.

This belongs in the LLM adapter, not in the UI and not in individual tools.

Sketch:

```ts
interface StreamingToolAccumulator {
	accept(delta: ProviderDelta): void;
	hasOpenToolCalls(): boolean;
	completeToolCalls(): ToolCall[];
	answerDelta(): string;
}
```

## UI Guidance

The UI should display user-facing process, not raw chain-of-thought or provider markup.

Good:

```text
Running search_notes
Search query: duzhe
Found 5 references
Running read_note
Writing answer
```

Bad:

```text
<|DSML| tool_calls>
raw JSON tool arguments
hidden chain-of-thought
provider-internal markup
```

## Prompting Guidance

Prompting can reduce leakage but must not be the only protection.

Useful instruction:

```text
Use the provider tool-calling API only. Never write XML, DSML, JSON tool-call markup, or pseudo tool calls in message content.
```

Still, the code must enforce:

```text
Do not render content that looks like a tool call.
Do not remove tools from the loop until the model returns a final answer.
```

## Implementation Checklist

Before attempting streaming tool calling again:

- Keep `AgentRunner` as a bounded tool loop.
- Add tests or manual fixtures for multi-step tools: `search_notes -> read_note -> answer`.
- Add a fixture where the model returns text containing `tool_calls` and verify it is not rendered.
- Decide whether V1 needs answer token streaming or only process streaming.
- If adding true streaming tool calls, implement it inside `src/llm/chat.ts` as a provider adapter.
- Do not parse DSML as the normal path.
- Do not start a normal streaming request without tools while the model may still need tools.

