import { z } from "zod";
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "../tools/proveedor.js";

export const tools = {
  proveedor_leer_solicitud: leer_solicitud,
  proveedor_mapear_campos: mapear_campos,
  proveedor_generar_formulario: generar_formulario,
  proveedor_armar_paquete: armar_paquete,
  proveedor_simular_envio: simular_envio,
} as const;

export type ToolName = keyof typeof tools;
export type Provider = "openai" | "anthropic" | "ollama" | "mock";
export type LlmMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; callId?: string; name?: string; calls?: LlmCall[] };
export type LlmCall = { id: string; name: string; arguments: unknown };
export type LlmResult = { text: string; calls: LlmCall[] };
export type LlmConfig = { provider: Provider; model: string; apiKey: string; baseUrl: string };

export interface LlmAdapter {
  turn(history: LlmMessage[]): Promise<LlmResult>;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: z.core.JSONSchema.JSONSchema;
}

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(tools) as ToolName[]).map((name) => ({ name, description: tools[name].description, parameters: z.toJSONSchema(tools[name].args, { target: "draft-07" }) }));
}
