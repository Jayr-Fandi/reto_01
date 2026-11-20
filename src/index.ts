/**
 * Punto de entrada del agente de registro de proveedor.
 *
 * El System Prompt y las reglas de negocio NO viven en el codigo: son la
 * fuente unica en `modulo/` (modulo/agent.md y
 * modulo/skill/registro-proveedor/SKILL.md). Este modulo solo expone las rutas
 * y la sincronizacion de los archivos derivados para que no haya copias
 * divergentes.
 */

export interface ReuseTarget {
  /** Archivo fuente unico (fuente de verdad). */
  readonly source: string;
  /** Archivo derivado que reutiliza el contenido de `source`. */
  readonly target: string;
}

/** Mapa de reutilizacion: cada derivado apunta a su fuente en `modulo/`. */
export const REUSE_TARGETS: readonly ReuseTarget[] = [
  { source: "modulo/agent.md", target: "agent/prompt.md" },
  {
    source: "modulo/skill/registro-proveedor/SKILL.md",
    target: "src/knowledge/registro-proveedor.md",
  },
] as const;

/** Fuente unica del System Prompt del agente. */
export const AGENT_PROMPT_SOURCE = "modulo/agent.md";

/** Fuente unica de las reglas de negocio del registro de proveedor. */
export const SKILL_SOURCE =
  "modulo/skill/registro-proveedor/SKILL.md";

/**
 * Cierra el ciclo de reutilizacion: `npm run sync` reescribe cada archivo
 * derivado a partir de su fuente en `modulo/`.
 */
export function reuseSyncCommand(): string {
  return "npm run sync";
}

export function describeReuse(): string {
  return REUSE_TARGETS.map(
    ({ source, target }) => `${target} <- ${source}`,
  ).join("\n");
}