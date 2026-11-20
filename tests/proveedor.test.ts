import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "../src/tools/proveedor.js";

interface Result<T> { ok: boolean; data?: T; error?: string }
function parse<T>(output: string): T {
  const result = JSON.parse(output) as Result<T>;
  assert.equal(result.ok, true, result.error);
  assert.ok(result.data);
  return result.data;
}

const cases = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"];

for (const caso of cases) {
  test(`flujo ${caso}: mapeo, formato, soportes, seguridad y bitácora`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "proveedor-test-"));
    const ctx = { directory, sessionId: "prueba" };
    try {
      const input = parse<{ pais: string; formato: string; campos: Array<{ etiqueta: string }> }>(await leer_solicitud.execute({ caso }, ctx));
      const mapped = parse<{ llenos: Array<{ etiqueta: string; ruta: string; valor: string | number }>; faltantes: Array<{ etiqueta: string; valor: null }>; requiere_confirmacion: Array<{ etiqueta: string; valor: string; nota: string }> }>(await mapear_campos.execute({ caso, campos: input.campos }, ctx));
      assert.equal(mapped.llenos.length + mapped.faltantes.length + mapped.requiere_confirmacion.length, input.campos.length);
      assert.ok(mapped.llenos.every((field) => field.ruta && field.valor !== null));
      assert.ok(mapped.faltantes.every((field) => field.valor === null));
      const form = parse<{ estado: string; ruta: string }>(await generar_formulario.execute({ caso, mapeo: mapped }, ctx));
      const pkg = parse<{ estado: string; listo_para_firma: boolean; soportes: Array<{ tipo: string; estado: string }>; bloqueos: string[]; correo_borrador: { cuerpo: string }; identificador_tributario: { etiqueta: string; nota: string | null } }>(await armar_paquete.execute({ caso }, ctx));
      assert.ok(!pkg.correo_borrador.cuerpo.includes("03100012345"));
      assert.ok(!pkg.correo_borrador.cuerpo.includes("COLOCOBM"));
      assert.ok(!pkg.correo_borrador.cuerpo.includes("Bancolombia"));
      assert.equal(pkg.listo_para_firma, caso === "co-industrias-delta");
      assert.equal(pkg.estado, pkg.listo_para_firma ? "listo_para_firma" : "requiere_revision");
      if (input.pais !== "CO") {
        assert.equal(pkg.identificador_tributario.nota, "identificador extranjero");
        assert.equal(mapped.requiere_confirmacion.length, 1);
      }
      assert.equal(pkg.identificador_tributario.etiqueta, input.pais === "HN" ? "RTN" : input.pais === "CO" ? "NIT" : "RUC");
      if (caso === "ec-corp-andina") {
        assert.deepEqual(mapped.faltantes.map((field) => field.etiqueta), ["Número de contribuyente especial"]);
        assert.ok(pkg.soportes.some((item) => item.estado === "ausente"));
        const bytes = await readFile(form.ruta);
        const pdf = await PDFDocument.load(bytes);
        assert.ok(pdf.getPageCount() >= 1);
      }
      if (caso === "hn-agroexport-sula") {
        assert.deepEqual(mapped.faltantes.map((field) => field.etiqueta), ["Referencias comerciales"]);
        assert.ok(pkg.soportes.every((item) => item.estado === "presente"));
        assert.ok(pkg.bloqueos.some((item) => item.includes("campo obligatorio faltante")));
      }
      if (caso === "pa-logistica-istmo") {
        assert.equal(form.estado, "formato no soportado");
        assert.match(await readFile(form.ruta, "utf8"), /RUC: 900123456/);
      }
      if (caso === "co-industrias-delta") {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(form.ruta);
        assert.equal(workbook.getWorksheet("Datos Proveedor")?.getCell("B4").value, "NIT");
        assert.equal(workbook.getWorksheet("Datos Proveedor")?.getCell("C4").value, "900123456");
        assert.equal(workbook.getWorksheet("Datos Bancarios")?.getCell("C5").value, "03100012345");
      }
      const denied = JSON.parse(await simular_envio.execute({ caso, confirmado: false }, ctx)) as Result<unknown>;
      assert.deepEqual({ ok: denied.ok, error: denied.error }, { ok: false, error: "requiere confirmación explícita" });
      assert.ok(!(await readdir(resolve(directory, "out", caso))).includes("ENVIO-SIMULADO.md"));
      const confirmed = parse<{ ruta: string }>(await simular_envio.execute({ caso, confirmado: true }, ctx));
      assert.match(await readFile(confirmed.ruta, "utf8"), /No se envió ningún correo real/);
      const log = (await readFile(resolve(directory, "out", caso, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { ts: string; herramienta: string; ok: boolean; resumen: string });
      assert.equal(log.length, 6);
      assert.deepEqual(log.map((line) => line.herramienta), ["leer_solicitud", "mapear_campos", "generar_formulario", "armar_paquete", "simular_envio", "simular_envio"]);
      assert.ok(log.every((line) => line.ts && typeof line.resumen === "string"));
      assert.equal(log[4]?.ok, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("valida argumentos y no confía en valores falsificados", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proveedor-test-"));
  const ctx = { directory, sessionId: "prueba" };
  try {
    const bad = JSON.parse(await leer_solicitud.execute({ caso: "../maestro" }, ctx)) as Result<unknown>;
    assert.equal(bad.ok, false);
    const caso = "co-industrias-delta";
    const input = parse<{ campos: Array<{ etiqueta: string }> }>(await leer_solicitud.execute({ caso }, ctx));
    const mapeo = parse<{ llenos: Array<{ etiqueta: string; valor: string | number }>; faltantes: unknown[]; requiere_confirmacion: unknown[] }>(await mapear_campos.execute({ caso, campos: input.campos }, ctx));
    mapeo.llenos[0] = { ...mapeo.llenos[0]!, valor: "inventado" };
    const forged = JSON.parse(await generar_formulario.execute({ caso, mapeo }, ctx)) as Result<unknown>;
    assert.equal(forged.ok, false);
    assert.match(forged.error ?? "", /no coincide/);
    const logs = (await readFile(resolve(directory, "out", caso, "log.jsonl"), "utf8")).trim().split("\n");
    assert.equal(logs.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
