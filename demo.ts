import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "./src/tools/proveedor.js";

const ctx = { directory: process.cwd(), sessionId: "demo" };

type Response = { ok: boolean; data?: unknown; error?: string };

function requireData<T>(response: string): T {
  const result = JSON.parse(response) as Response;
  if (!result.ok) throw new Error(result.error ?? "Error de herramienta");
  return result.data as T;
}

async function main(): Promise<void> {
  await rm(resolve(ctx.directory, "out"), { recursive: true, force: true });
  const casos = (await readdir(resolve(ctx.directory, "fixtures", "reto-01", "casos"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const caso of casos) {
    const solicitud = requireData<{ campos: Array<{ etiqueta: string; obligatorio?: boolean }> }>(await leer_solicitud.execute({ caso }, ctx));
    const mapeo = requireData<{ llenos: unknown[]; faltantes: unknown[]; requiere_confirmacion: unknown[] }>(await mapear_campos.execute({ caso, campos: solicitud.campos }, ctx));
    const formulario = requireData<{ estado: string; ruta: string }>(await generar_formulario.execute({ caso, mapeo }, ctx));
    const paquete = requireData<{ estado: string; soportes: Array<{ estado: string }>; bloqueos: string[] }>(await armar_paquete.execute({ caso }, ctx));
    const sinConfirmar = JSON.parse(await simular_envio.execute({ caso, confirmado: false }, ctx)) as Response;
    if (sinConfirmar.ok || sinConfirmar.error !== "requiere confirmación explícita") throw new Error(`Error de confirmación en ${caso}`);
    console.log(`${caso} | ${paquete.estado} | ${formulario.estado} | llenos=${mapeo.llenos.length} faltantes=${mapeo.faltantes.length} confirmar=${mapeo.requiere_confirmacion.length} soportes=${paquete.soportes.map((item) => item.estado).join(",")} bloqueos=${paquete.bloqueos.length} | envío=no simulado`);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
