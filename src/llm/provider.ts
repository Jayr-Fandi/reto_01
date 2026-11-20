import { z } from "zod";
import { toolDefinitions, type LlmAdapter, type LlmConfig, type LlmMessage, type LlmResult } from "./adapter.js";

const configSchema = z.enum(["openai", "anthropic", "ollama", "mock"]);
const callSchema = z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) });
const openAiResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(callSchema).optional() }) })).min(1) });
const anthropicBlock = z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string() }), z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })]);
const anthropicResponse = z.object({ content: z.array(anthropicBlock) });
const ollamaResponse = z.object({ message: z.object({ content: z.string(), tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) })).optional() }) });

export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = configSchema.safeParse(env.LLM_PROVIDER || "mock");
  if (!provider.success) return { provider: "mock", model: "", apiKey: "", baseUrl: "" };
  const apiKey = env.LLM_API_KEY ?? "";
  const selected = provider.data === "mock" || (provider.data !== "ollama" && !apiKey) ? "mock" : provider.data;
  return { provider: selected, model: env.LLM_MODEL || (selected === "openai" ? "gpt-4o-mini" : selected === "anthropic" ? "claude-sonnet-4-5" : selected === "ollama" ? "llama3.1" : ""), apiKey, baseUrl: env.LLM_BASE_URL || (selected === "openai" ? "https://api.openai.com/v1" : selected === "anthropic" ? "https://api.anthropic.com/v1" : "http://localhost:11434") };
}

function normalizeArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function url(base: string, suffix: string): string {
  const parsed = new URL(base);
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) throw new Error("Protocolo LLM inválido");
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

async function post(endpoint: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Proveedor LLM respondió ${response.status}`);
  return response.json() as Promise<unknown>;
}

export class MockProvider implements LlmAdapter {
  async turn(_history: LlmMessage[]): Promise<LlmResult> {
    return { text: "", calls: [] };
  }
}

export class AnthropicProvider implements LlmAdapter {
  constructor(private readonly config: LlmConfig) {}

  async turn(history: LlmMessage[]): Promise<LlmResult> {
    const definitions = toolDefinitions();
    const system = history.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const item of history) {
      if (item.role === "user") messages.push({ role: "user", content: item.content });
      if (item.role === "assistant") messages.push({ role: "assistant", content: item.calls?.length ? [...(item.content ? [{ type: "text", text: item.content }] : []), ...item.calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments }))] : item.content });
      if (item.role === "tool") messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.callId, content: item.content }] });
    }
    const data = anthropicResponse.parse(await post(url(this.config.baseUrl, "/messages"), { "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" }, { model: this.config.model, max_tokens: 2048, system, messages, tools: definitions.map((item) => ({ name: item.name, description: item.description, input_schema: item.parameters })) }));
    return { text: data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), calls: data.content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, arguments: block.input })) };
  }
}

export class OllamaProvider implements LlmAdapter {
  constructor(private readonly config: LlmConfig) {}

  async turn(history: LlmMessage[]): Promise<LlmResult> {
    const definitions = toolDefinitions();
    const messages = history.map((item) => item.role === "tool" ? { role: "tool", content: item.content, tool_name: item.name } : item.role === "assistant" && item.calls?.length ? { role: "assistant", content: item.content, tool_calls: item.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : { role: item.role, content: item.content });
    const data = ollamaResponse.parse(await post(url(this.config.baseUrl, "/api/chat"), {}, { model: this.config.model, stream: false, messages, tools: definitions.map((item) => ({ type: "function", function: { name: item.name, description: item.description, parameters: item.parameters } })) }));
    return { text: data.message.content, calls: (data.message.tool_calls ?? []).map((call, index) => ({ id: `ollama-${index}`, name: call.function.name, arguments: normalizeArguments(call.function.arguments) })) };
  }
}

export class OpenAiProvider implements LlmAdapter {
  constructor(private readonly config: LlmConfig) {}

  async turn(history: LlmMessage[]): Promise<LlmResult> {
    const definitions = toolDefinitions();
    const messages = history.map((item) => item.role === "tool" ? { role: "tool", content: item.content, tool_call_id: item.callId } : item.role === "assistant" && item.calls?.length ? { role: "assistant", content: item.content || null, tool_calls: item.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: item.role, content: item.content });
    const data = openAiResponse.parse(await post(url(this.config.baseUrl, "/chat/completions"), { authorization: `Bearer ${this.config.apiKey}` }, { model: this.config.model, messages, tools: definitions.map((item) => ({ type: "function", function: { name: item.name, description: item.description, parameters: item.parameters } })), tool_choice: "auto" }));
    const message = data.choices[0]!.message;
    return { text: message.content ?? "", calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: normalizeArguments(call.function.arguments) })) };
  }
}

export function createProvider(config: LlmConfig): LlmAdapter {
  switch (config.provider) {
    case "openai": return new OpenAiProvider(config);
    case "anthropic": return new AnthropicProvider(config);
    case "ollama": return new OllamaProvider(config);
    case "mock": return new MockProvider();
  }
}

export function llmTurn(config: LlmConfig, history: LlmMessage[]): Promise<LlmResult> {
  return createProvider(config).turn(history);
}
