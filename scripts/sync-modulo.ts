import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SyncTarget {
  readonly source: string;
  readonly target: string;
  readonly start: string;
  readonly end: string;
}

const TARGETS: readonly SyncTarget[] = [
  {
    source: "modulo/agent.md",
    target: "agent/prompt.md",
    start: "<!-- INICIO: contenido reutilizado de modulo/agent.md -->",
    end: "<!-- FIN: contenido reutilizado de modulo/agent.md -->",
  },
  {
    source: "modulo/skill/registro-proveedor/SKILL.md",
    target: "src/knowledge/registro-proveedor.md",
    start:
      "<!-- INICIO: contenido reutilizado de modulo/skill/registro-proveedor/SKILL.md -->",
    end:
      "<!-- FIN: contenido reutilizado de modulo/skill/registro-proveedor/SKILL.md -->",
  },
];

function syncTarget(target: SyncTarget): boolean {
  const sourcePath = resolve(ROOT, target.source);
  const targetPath = resolve(ROOT, target.target);
  const content = readFileSync(sourcePath, "utf8");
  const shell = readFileSync(targetPath, "utf8");

  const startIndex = shell.indexOf(target.start);
  const endIndex = shell.indexOf(target.end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Marcadores no encontrados en ${target.target}`);
  }

  const before = shell.slice(0, startIndex + target.start.length);
  const after = shell.slice(endIndex);
  const rebuilt = `${before}\n${content}\n${after}`;

  if (rebuilt === shell) {
    return false;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, rebuilt, "utf8");
  return true;
}

function main(): void {
  let changed = 0;
  for (const target of TARGETS) {
    if (syncTarget(target)) {
      changed += 1;
      console.log(`sync: ${target.target} <- ${target.source}`);
    } else {
      console.log(`ok (sin cambios): ${target.target}`);
    }
  }
  console.log(`Sincronizados ${changed} de ${TARGETS.length} archivos.`);
}

main();