import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const FIXTURES = resolve(ROOT, "fixtures", "reto-01");
const casoSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe("Identificador de caso dentro de fixtures/reto-01/casos");
const fieldSchema = z.object({
  etiqueta: z.string().min(1).describe("Etiqueta literal del formato del cliente"),
  obligatorio: z.boolean().optional().describe("Si el campo es obligatorio en la plantilla"),
  hoja: z.string().optional().describe("Hoja XLSX de la plantilla"),
  celda_etiqueta: z.string().optional().describe("Celda XLSX de la etiqueta"),
  celda_valor: z.string().optional().describe("Celda XLSX del valor"),
}).strict();
const mappedSchema = z.object({
  etiqueta: z.string().describe("Etiqueta del cliente"),
  campo: z.string().nullable().describe("Ruta canónica exacta del maestro o null"),
  ruta: z.string().nullable().describe("Ruta exacta del valor dentro de maestro.json o null"),
  valor: z.union([z.string(), z.number(), z.boolean()]).nullable().describe("Valor literal del maestro o null"),
  obligatorio: z.boolean().describe("Obligatoriedad en la plantilla"),
  estado: z.enum(["ok", "faltante"]).describe("Estado de resolución del valor"),
  confianza: z.number().min(0).max(1).describe("Confianza en el mapeo del glosario"),
  nota: z.string().nullable().describe("Motivo de confirmación o null"),
  requiere_confirmacion: z.boolean().describe("Si requiere revisión humana"),
}).strict();
const mappingSchema = z.object({
  llenos: z.array(mappedSchema).describe("Campos resueltos sin confirmación"),
  faltantes: z.array(mappedSchema).describe("Campos sin valor conocido"),
  requiere_confirmacion: z.array(mappedSchema).describe("Campos con valor que requieren confirmación"),
}).strict();
const requestSchema = z.object({
  id: casoSchema,
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.iso.date(),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]),
  cliente: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
});
const cellTemplateSchema = z.array(z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]+[1-9][0-9]*$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]+[1-9][0-9]*$/),
}));
const supportSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.iso.date().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string(),
});
const valueSchema = z.union([z.string(), z.number(), z.boolean()]);
const bankFields = new Set(["banco.nombre", "banco.tipo_cuenta", "banco.numero_cuenta", "banco.titular", "banco.swift"]);
const bankLabels = new Set(["Banco", "Tipo de cuenta", "Número de cuenta", "Titular de la cuenta", "SWIFT"]);

type Solicitud = z.infer<typeof requestSchema>;
type Campo = z.infer<typeof fieldSchema>;
type Mapeado = z.infer<typeof mappedSchema>;
type Mapeo = z.infer<typeof mappingSchema>;
type Soporte = z.infer<typeof supportSchema>;
type Resultado<T> = { ok: true; data: T } | { ok: false; error: string };

function casoDir(caso: string): string {
  return resolve(FIXTURES, "casos", caso);
}

function outputDir(caso: string, ctx: ToolContext): string {
  return resolve(ctx.directory, "out", caso);
}

function safeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

async function jsonFile<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function solicitud(caso: string): Promise<Solicitud> {
  const input = await jsonFile(resolve(casoDir(caso), "solicitud.json"), requestSchema);
  if (input.id !== caso) {
    return Promise.reject(new Error("El identificador de solicitud no coincide con el caso"));
  }
  return input;
}

async function plantilla(input: Solicitud): Promise<Campo[]> {
  if (input.formato === "xlsx") {
    const cells = await jsonFile(resolve(casoDir(input.id), "plantilla-celdas.json"), cellTemplateSchema);
    return cells.map((cell) => ({ ...cell, obligatorio: true }));
  }
  return jsonFile(resolve(casoDir(input.id), "plantilla-campos.json"), z.array(fieldSchema));
}

function errorText(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Entrada inválida: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : "Error desconocido";
}

async function runTool<T extends z.ZodType, R>(
  herramienta: string,
  schema: T,
  args: unknown,
  ctx: ToolContext,
  work: (input: z.output<T>) => Promise<R>,
): Promise<string> {
  let caso: string | undefined;
  let result: Resultado<R>;
  let resumen: string;
  try {
    const parsed = schema.parse(args);
    const record = parsed as { caso: string };
    caso = record.caso;
    if (!ctx || typeof ctx.directory !== "string" || !ctx.directory || typeof ctx.sessionId !== "string") {
      return JSON.stringify({ ok: false, error: "Contexto de herramienta inválido" });
    }
    const data = await work(parsed);
    result = { ok: true, data };
    resumen = "ejecutada";
  } catch (error: unknown) {
    result = { ok: false, error: errorText(error) };
    resumen = "error: " + result.error;
    const candidate = z.object({ caso: casoSchema }).safeParse(args);
    if (!caso && candidate.success) caso = candidate.data.caso;
  }
  if (caso && ctx && typeof ctx.directory === "string" && ctx.directory) {
    try {
      const dir = outputDir(caso, ctx);
      await mkdir(dir, { recursive: true });
      await appendFile(resolve(dir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), caso, paso: herramienta, accion: "execute", detalle: resumen, herramienta, ok: result.ok, resumen }) + "\n", "utf8");
    } catch (error: unknown) {
      result = { ok: false, error: `No se pudo registrar log: ${errorText(error)}` };
    }
  }
  return JSON.stringify(result);
}

function getValue(data: Record<string, unknown>, path: string): z.infer<typeof valueSchema> | null {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  const parsed = valueSchema.safeParse(current);
  return parsed.success && current !== "" ? parsed.data : null;
}

async function mapear(input: Solicitud, fields: Campo[]): Promise<Mapeo> {
  const maestro = await jsonFile(resolve(FIXTURES, "repositorio", "maestro.json"), z.record(z.string(), z.unknown()));
  const glosario = await jsonFile(resolve(FIXTURES, "glosario-campos.json"), z.record(z.string(), z.string()));
  const result: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };
  for (const field of fields) {
    const campo = glosario[field.etiqueta] ?? null;
    const valor = campo ? getValue(maestro, campo) : null;
    const extranjero = campo === "nit" && input.pais !== "CO";
    const confianza = campo ? 1 : 0;
    const nota = extranjero ? "identificador extranjero" : null;
    const mapped: Mapeado = {
      etiqueta: field.etiqueta,
      campo,
      ruta: valor === null ? null : campo,
      valor,
      obligatorio: field.obligatorio ?? true,
      estado: valor === null ? "faltante" : "ok",
      confianza,
      nota,
      requiere_confirmacion: valor !== null && (confianza < 0.8 || extranjero),
    };
    if (valor === null) result.faltantes.push(mapped);
    else if (mapped.requiere_confirmacion) result.requiere_confirmacion.push(mapped);
    else result.llenos.push(mapped);
  }
  return result;
}

async function soportes(input: Solicitud): Promise<string[]> {
  const exigidos = await jsonFile(resolve(casoDir(input.id), "soportes-exigidos.json"), z.array(z.string()));
  const catalog = await jsonFile(resolve(FIXTURES, "repositorio", "soportes", "index.json"), z.array(supportSchema));
  const terms: Record<string, string[]> = {
    camara_comercio: ["cámara de comercio", "certificado de existencia", "constancia de existencia"],
    rut: ["rut", "registro tributario"],
    certificacion_bancaria: ["certificación bancaria"],
    estados_financieros: ["estados financieros"],
    parafiscales: ["parafiscales", "obligaciones laborales"],
    certificado_iso_9001: ["iso 9001"],
    certificado_cumplimiento_tributario: ["cumplimiento tributario"],
  };
  const body = input.cuerpo.toLocaleLowerCase("es");
  for (const tipo of new Set([...Object.keys(terms), ...catalog.map((item) => item.tipo)])) {
    if (terms[tipo]?.some((term) => body.includes(term)) && !exigidos.includes(tipo)) exigidos.push(tipo);
  }
  return exigidos;
}

function allMapped(mapeo: Mapeo): Mapeado[] {
  return [...mapeo.llenos, ...mapeo.faltantes, ...mapeo.requiere_confirmacion];
}

function formatted(value: Mapeado["valor"]): string {
  return value === null ? "[FALTANTE]" : String(value);
}

export const leer_solicitud = {
  description: "Lee la solicitud, plantilla y soportes exigidos de un caso de registro de proveedor.",
  args: z.object({ caso: casoSchema }).strict(),
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return runTool("leer_solicitud", this.args, args, ctx, async ({ caso }) => {
      const input = await solicitud(caso);
      return { pais: input.pais, cliente: input.cliente, formato: input.formato, campos: await plantilla(input), soportes: await soportes(input) };
    });
  },
};

export const mapear_campos = {
  description: "Resuelve etiquetas mediante glosario y maestro, sin deducir valores ausentes.",
  args: z.object({ caso: casoSchema, campos: z.array(fieldSchema).describe("Campos literales solicitados en la plantilla") }).strict(),
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return runTool("mapear_campos", this.args, args, ctx, async ({ caso, campos }) => mapear(await solicitud(caso), campos));
  },
};

export const generar_formulario = {
  description: "Genera formulario XLSX/PDF o lista de valores de portal según la plantilla del caso.",
  args: z.object({ caso: casoSchema, mapeo: mappingSchema.describe("Resultado validado de mapear_campos") }).strict(),
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return runTool("generar_formulario", this.args, args, ctx, async ({ caso, mapeo }) => {
      const input = await solicitud(caso);
      const fields = await plantilla(input);
      const expected = await mapear(input, fields);
      const expectedByLabel = allMapped(expected);
      const supplied = allMapped(mapeo);
      if (supplied.length !== expectedByLabel.length || supplied.some((field) => !expectedByLabel.some((match) => match.etiqueta === field.etiqueta && JSON.stringify(match) === JSON.stringify(field)))) {
        return Promise.reject(new Error("El mapeo no coincide con el maestro y la plantilla"));
      }
      const ordered = fields.map((field) => expectedByLabel.find((item) => item.etiqueta === field.etiqueta));
      if (ordered.some((item) => !item)) return Promise.reject(new Error("Faltan campos de la plantilla"));
      const dir = outputDir(caso, ctx);
      await mkdir(dir, { recursive: true });
      if (input.formato === "xlsx") {
        const cells = await jsonFile(resolve(casoDir(caso), "plantilla-celdas.json"), cellTemplateSchema);
        const workbook = new ExcelJS.Workbook();
        for (const cell of cells) {
          const sheet = workbook.getWorksheet(cell.hoja) ?? workbook.addWorksheet(cell.hoja);
          sheet.getCell(cell.celda_etiqueta).value = cell.etiqueta;
          const value = expectedByLabel.find((item) => item.etiqueta === cell.etiqueta)?.valor;
          sheet.getCell(cell.celda_valor).value = value === null || value === undefined ? null : value;
        }
        const ruta = resolve(dir, "formulario.xlsx");
        await workbook.xlsx.writeFile(ruta);
        return { estado: "generado", ruta };
      }
      if (input.formato === "portal") {
        const ruta = resolve(dir, "valores-portal.md");
        await writeFile(ruta, ["# Valores para portal", "", ...ordered.map((field, index) => `${index + 1}. ${field?.etiqueta}: ${formatted(field?.valor ?? null)}`), ""].join("\n"), "utf8");
        return { estado: "formato no soportado", ruta };
      }
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      let page = pdf.addPage([612, 792]);
      let y = 750;
      for (const field of ordered) {
        if (y < 50) { page = pdf.addPage([612, 792]); y = 750; }
        const line = `${field?.etiqueta}: ${formatted(field?.valor ?? null)}`;
        const ascii = line.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?");
        let rest = ascii;
        while (rest.length) {
          if (y < 50) { page = pdf.addPage([612, 792]); y = 750; }
          const part = rest.slice(0, 92);
          page.drawText(part, { x: 40, y, size: 10, font });
          y -= 20;
          rest = rest.slice(92);
        }
      }
      const ruta = resolve(dir, "formulario.pdf");
      await writeFile(ruta, await pdf.save());
      return { estado: "generado", ruta };
    });
  },
};

export const armar_paquete = {
  description: "Copia formulario y soportes disponibles y prepara checklist y borrador sin datos bancarios.",
  args: z.object({ caso: casoSchema }).strict(),
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return runTool("armar_paquete", this.args, args, ctx, async ({ caso }) => {
      const input = await solicitud(caso);
      const catalog = await jsonFile(resolve(FIXTURES, "repositorio", "soportes", "index.json"), z.array(supportSchema));
      const required = await soportes(input);
      const fields = await plantilla(input);
      const mapped = await mapear(input, fields);
      const dir = outputDir(caso, ctx);
      const packageDir = resolve(dir, "paquete");
      const form = input.formato === "portal" ? "valores-portal.md" : `formulario.${input.formato}`;
      const formPath = resolve(dir, form);
      await stat(formPath);
      await mkdir(packageDir, { recursive: true });
      await copyFile(formPath, resolve(packageDir, form));
      const states: Array<{ tipo: string; estado: "presente" | "ausente" | "vencido"; vigencia_hasta: string | null }> = [];
      for (const tipo of required) {
        const support: Soporte | undefined = catalog.find((item) => item.tipo === tipo);
        const present = support && safeName(support.archivo) ? await stat(resolve(FIXTURES, "repositorio", "soportes", support.archivo)).then((entry) => entry.isFile()).catch(() => false) : false;
        const estado = !support || !present ? "ausente" : support.vigencia_hasta !== null && support.vigencia_hasta < input.fecha ? "vencido" : "presente";
        states.push({ tipo, estado, vigencia_hasta: support?.vigencia_hasta ?? null });
        if (support && present) await copyFile(resolve(FIXTURES, "repositorio", "soportes", support.archivo), resolve(packageDir, support.archivo));
      }
      const faltantes = mapped.faltantes.filter((field) => field.obligatorio).map((field) => field.etiqueta);
      const confirmaciones = mapped.requiere_confirmacion.map((field) => field.etiqueta);
      const bloqueos = states.filter((item) => item.estado !== "presente").map((item) => `${item.tipo}: ${item.estado}`);
      bloqueos.push(...faltantes.map((item) => `campo obligatorio faltante: ${item}`));
      bloqueos.push(...confirmaciones.map((item) => `requiere confirmación: ${item}`));
      const listo_para_firma = states.every((item) => item.estado === "presente") && faltantes.length === 0 && confirmaciones.length === 0;
      const estado = listo_para_firma ? "listo_para_firma" : "requiere_revision";
      const checklist = ["# Checklist de soportes", "", `Fecha de referencia: ${input.fecha}`, `Estado: ${estado}`, `Listo para firma: ${listo_para_firma}`, "", ...states.map((item) => `- ${item.tipo}: ${item.estado} (vigencia_hasta: ${item.vigencia_hasta ?? "sin vencimiento"})`), "", "Bloqueos:", ...bloqueos.map((item) => `- ${item}`), ""].join("\n");
      const correoFields = allMapped(mapped).filter((field) => field.estado === "ok" && field.campo !== null && !bankFields.has(field.campo) && !bankLabels.has(field.etiqueta));
      const correo = { para: input.de, asunto: `Respuesta: ${input.asunto}`, cuerpo: [`Estimados ${input.cliente}:`, "", "Preparamos los datos solicitados para el registro de proveedor:", ...correoFields.map((field) => `- ${field.etiqueta}: ${formatted(field.valor)}`), "", "Soportes disponibles para entrega:", ...states.filter((item) => item.estado === "presente").map((item) => `- ${item.tipo}`), "", "Quedamos atentos a su confirmación."].join("\n") };
      const correoPath = resolve(packageDir, "borrador-correo.md");
      await writeFile(resolve(packageDir, "checklist.md"), checklist, "utf8");
      await writeFile(correoPath, [`Para: ${correo.para}`, `Asunto: ${correo.asunto}`, "", correo.cuerpo, ""].join("\n"), "utf8");
      const nit = getValue(await jsonFile(resolve(FIXTURES, "repositorio", "maestro.json"), z.record(z.string(), z.unknown())), "nit");
      const identificador_tributario = { etiqueta: input.pais === "CO" ? "NIT" : input.pais === "HN" ? "RTN" : "RUC", valor: nit, nota: input.pais === "CO" ? null : "identificador extranjero", requiere_confirmacion: input.pais !== "CO" };
      return { caso, pais: input.pais, cliente: input.cliente, formato: input.formato, estado, listo_para_firma, requiere_confirmacion: confirmaciones.length > 0, campos: fields.map((field) => { const match = allMapped(mapped).find((item) => item.etiqueta === field.etiqueta); return { etiqueta: field.etiqueta, campo: match?.campo ?? null, valor: match?.valor ?? null, obligatorio: field.obligatorio ?? true, estado: match?.estado ?? "faltante" }; }), identificador_tributario, soportes: states, bloqueos, correo_borrador: correo, ruta: packageDir };
    });
  },
};

export const simular_envio = {
  description: "Registra envío simulado solamente con confirmación explícita; nunca envía correo real.",
  args: z.object({ caso: casoSchema, confirmado: z.boolean().describe("Confirmación explícita de una persona para simular el envío") }).strict(),
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return runTool("simular_envio", this.args, args, ctx, async ({ caso, confirmado }) => {
      if (confirmado !== true) return Promise.reject(new Error("requiere confirmación explícita"));
      await solicitud(caso);
      const dir = outputDir(caso, ctx);
      await stat(resolve(dir, "paquete", "borrador-correo.md"));
      const ruta = resolve(dir, "ENVIO-SIMULADO.md");
      await writeFile(ruta, `# Envío simulado\n\nCaso: ${caso}\nConfirmación explícita: sí\nNo se envió ningún correo real.\n`, "utf8");
      return { ruta };
    });
  },
};
