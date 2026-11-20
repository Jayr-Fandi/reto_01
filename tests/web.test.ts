import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { AgentLoop, isExplicitConfirmation } from "../src/agent/loop.js";
import { toolDefinitions, type ToolName } from "../src/llm/adapter.js";
import { readLlmConfig } from "../src/llm/provider.js";
import { createApp } from "../src/server.js";

type Response = { reply: string; toolCalls: Array<{ name: string; ok: boolean }>; needsConfirmation: boolean; artifacts: Array<{ archivo: string }> };
let directory: string;
let server: Server;
let base: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "proveedor-web-"));
  server = createApp({ directory, loop: new AgentLoop({ directory, config: { provider: "mock", model: "", apiKey: "", baseUrl: "" } }) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Servidor de prueba no disponible");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(directory, { recursive: true, force: true });
});

async function chat(sessionId: string, message: string): Promise<Response> {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message }) });
  assert.equal(response.status, 200);
  return response.json() as Promise<Response>;
}

test("esquemas de las cinco herramientas se publican como JSON Schema y proveedores sin clave usan mock", () => {
  const definitions = toolDefinitions();
  assert.deepEqual(definitions.map((item) => item.name), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete", "proveedor_simular_envio"]);
  assert.ok(definitions.every((item) => item.parameters.type === "object" && item.parameters.properties?.caso));
  assert.equal(readLlmConfig({ LLM_PROVIDER: "anthropic" }).provider, "mock");
  assert.equal(readLlmConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "local" }).provider, "ollama");
  assert.equal(readLlmConfig({ LLM_PROVIDER: "openai", LLM_API_KEY: "test" }).provider, "openai");
});

test("servidor ofrece interfaz, casos, chat, artefactos y protege rutas", async () => {
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Inspector de casos/);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.match(await readFile(resolve(process.cwd(), "web", "index.html"), "utf8"), /Inspector de casos/);
  const initial = await (await fetch(`${base}/api/casos`)).json() as Array<{ caso: string; estado: string }>;
  assert.equal(initial.length, 4);
  assert.ok(initial.every((item) => item.estado === "sin_procesar"));
  const result = await chat("session-a", "Procesa el caso co-industrias-delta");
  assert.match(result.reply, /listo_para_firma/);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"]);
  assert.equal(result.artifacts.length, 4);
  assert.equal(result.needsConfirmation, true);
  const updated = await (await fetch(`${base}/api/casos`)).json() as Array<{ caso: string; estado: string }>;
  assert.equal(updated.find((item) => item.caso === "co-industrias-delta")?.estado, "listo_para_firma");
  for (const name of ["checklist.md", "borrador-correo.md", "log.jsonl", "formulario.xlsx"]) assert.equal((await fetch(`${base}/api/out/co-industrias-delta/${name}`)).status, 200);
  assert.equal((await fetch(`${base}/api/out/co-industrias-delta/maestro.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/out/co-industrias-delta/%2e%2e%2fmaestro.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "x", message: "" }) })).status, 400);
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "bad" })).status, 415);
});

test("health expone únicamente el proveedor y modelo efectivos; sessions conserva mensajes y herramientas", async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, provider: "mock", model: "" });
  assert.equal((await fetch(`${base}/api/sessions/inexistente`)).status, 404);
  const session = await fetch(`${base}/api/sessions/session-a`);
  assert.equal(session.status, 200);
  const history = await session.json() as { messages: Array<{ role: string; content: string }>; toolCalls: Array<{ name: string }> };
  assert.equal(history.messages[0]?.role, "user");
  assert.match(history.messages[0]?.content ?? "", /Procesa el caso/);
  assert.equal(history.messages.at(-1)?.role, "assistant");
  assert.deepEqual(history.toolCalls.map((call) => call.name), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"]);
  assert.equal(history.messages.filter((item) => item.role === "tool").length, 4);
});

test("RN4 niega ambigüedad, negación y confirmación de otro caso; solo permite la confirmación explícita", async () => {
  assert.equal(isExplicitConfirmation("no confirmo el envío de co-industrias-delta", "co-industrias-delta"), false);
  assert.equal(isExplicitConfirmation("confirmo el envío de co-industrias-delta", "co-industrias-delta"), true);
  const without = await chat("session-a", "Envíalo");
  assert.ok(without.toolCalls.every((call) => call.name !== "proveedor_simular_envio"));
  assert.equal(without.needsConfirmation, true);
  const negation = await chat("session-a", "No confirmo el envío de co-industrias-delta");
  assert.ok(negation.toolCalls.every((call) => call.name !== "proveedor_simular_envio"));
  const other = await chat("session-b", "Confirmo el envío de ec-corp-andina");
  assert.equal(other.toolCalls[0]?.ok, false);
  assert.equal((await fetch(`${base}/api/out/co-industrias-delta/ENVIO-SIMULADO.md`)).status, 404);
  const success = await chat("session-a", "Confirmo el envío de co-industrias-delta");
  assert.equal(success.toolCalls[0]?.name, "proveedor_simular_envio");
  assert.equal(success.toolCalls[0]?.ok, true);
  assert.equal(success.needsConfirmation, false);
  assert.match(await readFile(resolve(directory, "out", "co-industrias-delta", "ENVIO-SIMULADO.md"), "utf8"), /No se envió ningún correo real/);
});

test("RN4 permite la simulación únicamente tras confirmación explícita", async () => {
  const calls: Array<{ name: ToolName; args: unknown }> = [];
  const loop = new AgentLoop({ directory, config: { provider: "mock", model: "", apiKey: "", baseUrl: "" }, executor: async (name, args) => { calls.push({ name, args }); return { ok: true, data: { ruta: "test" } }; } });
  await loop.chat("falso", "confirmo el envío de co-industrias-delta");
  assert.deepEqual(calls.map((call) => call.name), ["proveedor_simular_envio"]);
});
