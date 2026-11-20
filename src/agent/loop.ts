import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tools, type LlmConfig, type LlmMessage, type ToolName } from "../llm/adapter.js";
import { llmTurn, readLlmConfig } from "../llm/provider.js";
import type { ToolContext } from "../../modulo/tools/proveedor.js";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const caseSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const readSchema = z.object({ pais: z.string(), cliente: z.string(), formato: z.string(), campos: z.array(z.unknown()), soportes: z.array(z.string()) });
const mappingSchema = z.object({ llenos: z.array(z.unknown()), faltantes: z.array(z.unknown()), requiere_confirmacion: z.array(z.unknown()) });
const packageSchema = z.object({ estado: z.string(), bloqueos: z.array(z.string()), soportes: z.array(z.object({ tipo: z.string(), estado: z.string() })) });
const toolResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: z.unknown() }), z.object({ ok: z.literal(false), error: z.string() })]);
export interface ToolCall { name: ToolName; ok: boolean; resumen: string }
export interface ChatResult { reply: string; toolCalls: ToolCall[]; needsConfirmation: boolean; artifacts: Array<{ caso: string; archivo: string; url: string }> }
export interface SessionHistory { messages: LlmMessage[]; toolCalls: ToolCall[] }
type Session = { history: LlmMessage[]; messages: LlmMessage[]; toolCalls: ToolCall[]; lastCase: string | null; readyCase: string | null };
type Executor = (name: ToolName, args: unknown, context: ToolContext) => Promise<unknown>;

const artifactNames = ["checklist.md", "borrador-correo.md", "valores-portal.md", "log.jsonl", "ENVIO-SIMULADO.md", "formulario.xlsx", "formulario.pdf"];

export class AgentLoop {
  private readonly sessions = new Map<string, Session>();
  private readonly queued = new Map<string, Promise<void>>();
  private readonly config: LlmConfig;
  private readonly directory: string;
  private readonly executor: Executor;
  private readonly prompt: Promise<string>;

  constructor(options: { directory: string; config?: LlmConfig; executor?: Executor }) {
    this.directory = options.directory;
    this.config = options.config ?? readLlmConfig();
    this.executor = options.executor ?? (async (name, args, context) => tools[name].execute(args, context));
    this.prompt = Promise.all([readFile(resolve(ROOT, "agent", "prompt.md"), "utf8"), readFile(resolve(ROOT, "src", "knowledge", "registro-proveedor.md"), "utf8")]).then(([system, knowledge]) => `${system}\n\n${knowledge}\n\nNunca incluyas datos bancarios en respuestas ni simules un envío sin confirmación explícita del usuario en el mensaje actual.`);
  }

  getSession(sessionId: string): SessionHistory | null {
    const session = this.sessions.get(sessionId);
    return session ? { messages: structuredClone(session.messages), toolCalls: structuredClone(session.toolCalls) } : null;
  }

  getConfig(): Pick<LlmConfig, "provider" | "model"> {
    return { provider: this.config.provider, model: this.config.model };
  }

  async chat(sessionId: string, message: string): Promise<ChatResult> {
    const previous = this.queued.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((done) => { release = done; });
    const current = previous.then(() => pending);
    this.queued.set(sessionId, current);
    await previous;
    try { return await this.turn(sessionId, message); }
    finally { release(); if (this.queued.get(sessionId) === current) this.queued.delete(sessionId); }
  }

  private async turn(sessionId: string, message: string): Promise<ChatResult> {
    const session = this.sessions.get(sessionId) ?? { history: [], messages: [], toolCalls: [], lastCase: null, readyCase: null };
    this.sessions.set(sessionId, session);
    const detected = message.toLowerCase().match(/\b(?:co|ec|hn|pa)-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0] ?? null;
    const caso = detected ?? session.lastCase;
    const calls: ToolCall[] = [];
    const artifacts: ChatResult["artifacts"] = [];
    const context: ToolContext = { directory: this.directory, sessionId };
    const confirmed = isExplicitConfirmation(message, detected);
    session.messages.push({ role: "user", content: message });
    const perform = async (name: ToolName, args: unknown): Promise<z.infer<typeof toolResultSchema>> => {
      if (name === "proveedor_simular_envio" && (!confirmed || !detected || !z.object({ caso: caseSchema, confirmado: z.literal(true) }).safeParse(args).success || (args as { caso: string }).caso !== detected)) {
        const denied = { ok: false as const, error: "requiere confirmación explícita del caso en el mensaje actual" };
        calls.push({ name, ok: false, resumen: denied.error });
        session.toolCalls.push(calls.at(-1)!);
        session.messages.push({ role: "tool", name, content: JSON.stringify(denied) });
        return denied;
      }
      const raw = await this.executor(name, args, context);
      const parsed = toolResultSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) as unknown : raw);
      const result = parsed.success ? parsed.data : { ok: false as const, error: "Respuesta inválida de herramienta" };
      calls.push({ name, ok: result.ok, resumen: result.ok ? "Ejecutada" : result.error });
      session.toolCalls.push(calls.at(-1)!);
      session.messages.push({ role: "tool", name, content: JSON.stringify(result) });
      if (result.ok && name === "proveedor_armar_paquete" && typeof args === "object" && args !== null && "caso" in args && typeof args.caso === "string") session.readyCase = args.caso;
      if (result.ok && name === "proveedor_simular_envio" && typeof args === "object" && args !== null && "caso" in args && args.caso === session.readyCase) session.readyCase = null;
      if (result.ok && typeof args === "object" && args !== null && "caso" in args && typeof args.caso === "string") {
        const file = name === "proveedor_generar_formulario" ? (result.data as { ruta?: string }).ruta?.split(/[\\/]/).at(-1) : name === "proveedor_simular_envio" ? "ENVIO-SIMULADO.md" : undefined;
        if (file && artifactNames.includes(file)) artifacts.push({ caso: args.caso, archivo: file, url: `/api/out/${args.caso}/${file}` });
        if (name === "proveedor_armar_paquete") for (const archivo of ["checklist.md", "borrador-correo.md", "log.jsonl"]) artifacts.push({ caso: args.caso, archivo, url: `/api/out/${args.caso}/${archivo}` });
      }
      return result;
    };
    let reply: string;
    if (this.config.provider === "mock") {
      reply = await this.offline(message, caso, detected, confirmed, perform);
    } else {
      reply = await this.online(session, message, detected, confirmed, perform);
    }
    if (detected) session.lastCase = detected;
    session.messages.push({ role: "assistant", content: reply });
    return { reply, toolCalls: calls, needsConfirmation: session.readyCase !== null && session.readyCase === caso, artifacts };
  }

  private async offline(message: string, caso: string | null, detected: string | null, confirmed: boolean, perform: (name: ToolName, args: unknown) => Promise<z.infer<typeof toolResultSchema>>): Promise<string> {
    const normal = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const negatedSend = /\b(no|nunca|sin|aun no|todavia no)\b.{0,35}\b(confirmo|apruebo|autoriz|envi|mand)\b/.test(normal);
    const wantsProcess = /(proces|prepar|arm|paquet|solicitud|revis|formulario|caso)/.test(normal);
    const wantsSend = !negatedSend && /(?:envi|confirm|aprob|autoriz)/.test(normal);

    if (wantsSend && (!wantsProcess || confirmed)) {
      const target = detected ?? caso;
      if (!confirmed || !detected) {
        const example = target ?? "co-industrias-delta";
        return `Para simular el envío, confirma explícitamente el caso: «Confirmo el envío de ${example}». No se envía correo real.`;
      }
      const result = await perform("proveedor_simular_envio", { caso: detected, confirmado: true });
      return result.ok ? `Envío de ${detected} simulado tras tu confirmación (out/${detected}/ENVIO-SIMULADO.md). No se envió ningún correo real.` : `No pude simular el envío: ${result.error}`;
    }

    if (!caso) return "Indica un caso, por ejemplo: «procesa el caso ec-corp-andina». También puedes pedir «arma el paquete» después de procesarlo.";
    if (!wantsProcess) return `Puedo procesar ${caso}, generar el formulario o armar su paquete. ¿Qué quieres hacer?`;

    const input = await perform("proveedor_leer_solicitud", { caso });
    if (!input.ok) return `No pude leer ${caso}: ${input.error}`;
    const read = readSchema.safeParse(input.data);
    if (!read.success) return "La solicitud contiene datos inesperados.";
    if (/(solicitud|leer)/.test(normal) && !/(proces|prepar|arm|paquet)/.test(normal)) return `${read.data.cliente} (${read.data.pais}): formato ${read.data.formato}, ${read.data.campos.length} campos y ${read.data.soportes.length} soportes exigidos.`;

    const mapped = await perform("proveedor_mapear_campos", { caso, campos: read.data.campos });
    if (!mapped.ok) return `No pude mapear ${caso}: ${mapped.error}`;
    const mapping = mappingSchema.safeParse(mapped.data);
    if (!mapping.success) return "El mapeo contiene datos inesperados.";

    const form = await perform("proveedor_generar_formulario", { caso, mapeo: mapped.data });
    if (!form.ok) return `No pude generar el formulario: ${form.error}`;

    const packageResult = await perform("proveedor_armar_paquete", { caso });
    if (!packageResult.ok) return `No pude armar el paquete: ${packageResult.error}`;
    const pkg = packageSchema.safeParse(packageResult.data);
    if (!pkg.success) return "El paquete contiene datos inesperados.";

    const llenosList = mapping.data.llenos.map((item) => (typeof item === "object" && item !== null && "etiqueta" in item ? String(item.etiqueta) : JSON.stringify(item)));
    const faltantesList = mapping.data.faltantes.map((item) => (typeof item === "object" && item !== null && "etiqueta" in item ? String(item.etiqueta) : String(item)));
    const soportesActualizar = pkg.data.soportes.filter((s) => s.estado !== "presente").map((s) => `${s.tipo} (${s.estado})`);
    const issues = pkg.data.bloqueos.length ? ` Bloqueos: ${pkg.data.bloqueos.join("; ")}.` : " Todos los soportes están presentes.";

    return [
      `**${read.data.cliente}** (${caso}) — Estado: **${pkg.data.estado}** · Artefactos en \`out/${caso}/\`.`,
      `- **Formato:** ${read.data.formato === "portal" ? "no soportado; valores listos para copiar en valores-portal.md" : `${read.data.formato.toUpperCase()} generado`}.`,
      `- **Campos llenos (${llenosList.length}):** ${llenosList.length ? llenosList.join(", ") : "ninguno"}.`,
      `- **Campos faltantes (${faltantesList.length}):** ${faltantesList.length ? faltantesList.join(", ") : "ninguno"}.`,
      `- **Por confirmar (${mapping.data.requiere_confirmacion.length}):** ${mapping.data.requiere_confirmacion.length ? "identificador extranjero (NIT)" : "ninguno"}.`,
      `- **Soportes a actualizar:** ${soportesActualizar.length ? soportesActualizar.join(", ") : "ninguno (todos vigentes)"}.${issues}`,
      `Preparé checklist y borrador; no se envió ningún correo. ¿Deseas confirmar el envío escribiendo «Confirmo el envío de ${caso}»?`
    ].join("\n");
  }

  private async online(session: Session, message: string, detected: string | null, confirmed: boolean, perform: (name: ToolName, args: unknown) => Promise<z.infer<typeof toolResultSchema>>): Promise<string> {
    const history: LlmMessage[] = [{ role: "system", content: await this.prompt }, ...session.history, { role: "user", content: message }];
    const replies: string[] = [];
    for (let round = 0; round < 12; round++) {
      const answer = await llmTurn(this.config, history);
      history.push({ role: "assistant", content: answer.text, calls: answer.calls });
      if (answer.text) replies.push(answer.text);
      if (!answer.calls.length) {
        session.history = history.slice(1).slice(-40);
        return replies.at(-1) || "Listo. Revisa el inspector para ver los artefactos.";
      }
      for (const call of answer.calls) {
        const name = call.name as ToolName;
        session.messages.push({ role: "assistant", content: "", calls: [call] });
        let result: z.infer<typeof toolResultSchema>;
        if (!Object.hasOwn(tools, name)) {
          result = { ok: false, error: "Herramienta desconocida" };
          session.toolCalls.push({ name, ok: false, resumen: result.error });
          session.messages.push({ role: "tool", name: call.name, callId: call.id, content: JSON.stringify(result) });
        }
        else if (name === "proveedor_simular_envio" && (!confirmed || !detected)) {
          result = { ok: false, error: "requiere confirmación explícita del caso en el mensaje actual" };
          session.toolCalls.push({ name, ok: false, resumen: result.error });
          session.messages.push({ role: "tool", name, callId: call.id, content: JSON.stringify(result) });
        } else result = await perform(name, call.arguments);
        history.push({ role: "tool", content: JSON.stringify(result), callId: call.id, name: call.name });
      }
    }
    session.history = history.slice(1).slice(-40);
    return "Alcancé el límite de pasos del agente; revisa los artefactos y vuelve a intentarlo.";
  }
}

export function isExplicitConfirmation(message: string, detected: string | null): boolean {
  if (!detected) return false;
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(no|nunca|sin|aun no|todavia no)\b.{0,35}\b(confirmo|apruebo|autoriza|envio|enviar)\b/.test(normalized)) return false;
  return /\b(confirmo|apruebo|autorizo)\b.{0,100}\b(envio|enviar|simular|simulacion)\b/.test(normalized) || /\b(confirmo|apruebo|autorizo)\b.{0,80}\b(?:co|ec|hn|pa)-[a-z0-9-]+\b/.test(normalized);
}
