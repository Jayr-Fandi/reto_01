import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentLoop } from "./agent/loop.js";
import { readLlmConfig } from "./llm/provider.js";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const WEB = resolve(ROOT, "web");
const FIXTURES = resolve(ROOT, "fixtures", "reto-01", "casos");
const caseSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const chatSchema = z.object({ sessionId: z.string().min(1).max(128), message: z.string().trim().min(1).max(4000) }).strict();
const allowedFiles = new Set(["checklist.md", "borrador-correo.md", "valores-portal.md", "log.jsonl", "ENVIO-SIMULADO.md", "formulario.xlsx", "formulario.pdf"]);
const allowedWeb = new Set(["index.html", "styles.css", "app.js"]);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pdf": "application/pdf" };

function respond(res: ServerResponse, status: number, body: string | Uint8Array, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", "Cache-Control": "no-store" });
  res.end(body);
}

function error(res: ServerResponse, status: number, message: string): void {
  respond(res, status, JSON.stringify({ error: message }));
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const item of req) {
    const part = Buffer.isBuffer(item) ? item : Buffer.from(item as Uint8Array);
    size += part.length;
    if (size > 16_384) throw new Error("Mensaje demasiado grande");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function availableCases(directory: string): Promise<Array<{ caso: string; cliente: string; pais: string; formato: string; estado: string; artifacts: string[] }>> {
  const entries = await readdir(FIXTURES, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isDirectory() && caseSchema.safeParse(entry.name).success).sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const solicitud = z.object({ cliente: z.string(), pais: z.string(), formato: z.string() }).parse(JSON.parse(await readFile(resolve(FIXTURES, entry.name, "solicitud.json"), "utf8")) as unknown);
    const out = resolve(directory, "out", entry.name);
    const artifacts: string[] = [];
    for (const name of allowedFiles) {
      const path = name === "checklist.md" || name === "borrador-correo.md" ? resolve(out, "paquete", name) : resolve(out, name);
      if (await stat(path).then((file) => file.isFile()).catch(() => false)) artifacts.push(name);
    }
    let estado = "sin_procesar";
    if (artifacts.includes("checklist.md")) {
      const checklist = await readFile(resolve(out, "paquete", "checklist.md"), "utf8");
      estado = /^Estado: listo_para_firma$/m.test(checklist) ? "listo_para_firma" : "requiere_revision";
    }
    return { caso: entry.name, ...solicitud, estado, artifacts };
  }));
}

export function createApp(options: { directory?: string; loop?: AgentLoop } = {}) {
  const directory = options.directory ?? ROOT;
  const agent = options.loop ?? new AgentLoop({ directory, config: readLlmConfig() });
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/api/health") {
        respond(res, 200, JSON.stringify({ ok: true, ...agent.getConfig() }));
        return;
      }
      if (req.method === "GET" && path.startsWith("/api/sessions/")) {
        const id = path.slice("/api/sessions/".length);
        if (!id || id.includes("/") || id.length > 128) { error(res, 404, "Sesión no encontrada"); return; }
        const session = agent.getSession(id);
        if (!session) { error(res, 404, "Sesión no encontrada"); return; }
        respond(res, 200, JSON.stringify(session));
        return;
      }
      if (req.method === "GET" && path === "/api/casos") {
        respond(res, 200, JSON.stringify(await availableCases(directory)));
        return;
      }
      if (req.method === "POST" && path === "/api/reset") {
        await rm(resolve(directory, "out"), { recursive: true, force: true });
        respond(res, 200, JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && path === "/api/chat") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) { error(res, 415, "Se requiere application/json"); return; }
        const input = chatSchema.safeParse(await bodyJson(req));
        if (!input.success) { error(res, 400, "sessionId o message inválido"); return; }
        respond(res, 200, JSON.stringify(await agent.chat(input.data.sessionId, input.data.message)));
        return;
      }
      if (req.method === "GET" && path.startsWith("/api/out/")) {
        const parts = path.split("/");
        if (parts.length !== 5 || !caseSchema.safeParse(parts[3]).success || !parts[4] || !allowedFiles.has(parts[4])) { error(res, 404, "Archivo no disponible"); return; }
        const caso = parts[3]!;
        if (!await stat(resolve(FIXTURES, caso, "solicitud.json")).then((entry) => entry.isFile()).catch(() => false)) { error(res, 404, "Caso no encontrado"); return; }
        const file = parts[4]!;
        const location = file === "checklist.md" || file === "borrador-correo.md" ? resolve(directory, "out", caso, "paquete", file) : resolve(directory, "out", caso, file);
        try { respond(res, 200, await readFile(location), types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream"); }
        catch { error(res, 404, "Archivo no encontrado"); }
        return;
      }
      if (req.method === "GET") {
        const file = path === "/" ? "index.html" : path.slice(1);
        if (allowedWeb.has(file)) {
          respond(res, 200, await readFile(resolve(WEB, file)), types[file.slice(file.lastIndexOf("."))]);
          return;
        }
      }
      error(res, 404, "Ruta no encontrada");
    } catch {
      error(res, 500, "No se pudo procesar la solicitud");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT debe ser un puerto válido");
    process.exitCode = 1;
  } else {
    await rm(resolve(ROOT, "out"), { recursive: true, force: true });
    createApp().listen(port, "0.0.0.0", () => console.log(`Registro de proveedor disponible en http://localhost:${port}`));
  }
}
