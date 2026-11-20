# Registro de proveedores · PERXIA

Aplicación web conversacional para diligenciar solicitudes de alta de Periferia IT Group como proveedor. Funciona sin clave de API en modo offline; no envía correos reales.

## Link de prueba

- **URL pública:** `https://reto-01-ilu1.onrender.com`
- **Clave de acceso:** No requiere autenticación (modo demo/offline activo por defecto; si se configura `LLM_PROVIDER=openai`, usar variables de entorno del servidor).

## Requisitos e inicio

- Node.js 20 o superior y npm.
- `npm install`
- `npm run dev` abre la aplicación en `http://localhost:3000` (puerto configurable mediante `PORT`). `npm start` también inicia el servidor.
- `npm run demo` limpia `out/` y procesa los cuatro casos de `fixtures/reto-01/casos/` sin claves de API.
- `npm test` ejecuta pruebas de herramientas, HTTP y confirmación de envío; `npm run typecheck`, `npm run lint` y `npm run build` comprueban TypeScript estricto. El build escribe en `dist/`; las herramientas escriben artefactos en `out/`.

En el chat escribe «Procesa el caso ec-corp-andina», «Arma el paquete» tras seleccionar un caso o «Confirmo el envío de co-industrias-delta». El último comando únicamente genera `ENVIO-SIMULADO.md` y **no envía correo**. Inspecciona checklist, borrador y logs en el panel derecho; los formularios se descargan desde allí.

## Arquitectura y carpetas

| Ruta | Responsabilidad |
| --- | --- |
| `modulo/agent.md`, `modulo/skill/registro-proveedor/SKILL.md` | Fuentes originales del prompt y las reglas del agente. |
| `agent/prompt.md`, `src/knowledge/registro-proveedor.md` | Versiones sincronizadas (`npm run sync`); leídas por el bucle conversacional. |
| `modulo/tools/proveedor.ts` | Fuente única de las cinco herramientas Zod: lectura, mapeo, formulario, paquete y simulación. |
| `src/tools/proveedor.ts` | Reexportación exacta, sin lógica duplicada. |
| `src/llm/adapter.ts` | Contratos tipados para mensajes, herramientas y proveedores; convierte Zod → JSON Schema para tool-calling. |
| `src/llm/provider.ts` | Implementaciones HTTP OpenAI, Anthropic y Ollama, proveedor Mock y selección mediante configuración. |
| `src/agent/llm.ts` | Reexportación de compatibilidad; el bucle importa directamente desde `src/llm/`. |
| `src/agent/loop.ts` | Sesiones en memoria, historial completo, modo offline en español, ejecución de herramientas y bloqueo de confirmación RN4. |
| `src/server.ts` | Servidor HTTP de Node: interfaz, casos, chat, sesiones, salud y artefactos. |
| `web/` | Interfaz web de chat e inspector sin framework ni dependencias cliente. |
| `fixtures/reto-01/` | Solicitudes, plantillas, maestro, glosario e índice y archivos de soportes. |
| `out/<caso>/` | Formulario XLSX/PDF o valores de portal, `log.jsonl`, `paquete/` y, solo con confirmación, `ENVIO-SIMULADO.md`. |
| `demo.ts`, `tests/` | Demostración determinista y pruebas automatizadas. |

## API HTTP

| Método y ruta | Respuesta |
| --- | --- |
| `GET /` | Interfaz HTML del chat (también sirve `/styles.css` y `/app.js`). |
| `GET /api/casos` | Lista de casos con cliente, país, formato, estado y artefactos disponibles. |
| `POST /api/chat` | Recibe JSON `{ "sessionId": "sesion-1", "message": "Procesa el caso co-industrias-delta" }` y devuelve `{ "reply": "...", "toolCalls": [...], "needsConfirmation": true, "artifacts": [...] }`. `needsConfirmation` solo es `true` cuando el paquete del caso quedó preparado y aún espera confirmación explícita de envío; vuelve a `false` después de simularlo. |
| `GET /api/sessions/:id` | `{ "messages": [...], "toolCalls": [...] }` con el historial completo de la sesión, incluidas las llamadas a herramientas; devuelve 404 para una sesión inexistente. Las sesiones viven en memoria hasta reiniciar el servidor. |
| `GET /api/health` | `{ "ok": true, "provider": "mock", "model": "" }` con el proveedor y modelo efectivos de la configuración, sin clave ni credenciales. |
| `GET /api/out/:caso/:archivo` | Descarga un artefacto existente de un caso conocido; 404 si no está disponible. |

Los artefactos servidos están limitados a nombres permitidos y casos conocidos. El servidor escucha únicamente en `0.0.0.0`; no incluye autenticación para exposición pública.

## Configuración

Copia `.env.example` a `.env` si deseas ajustar opciones. En Node 22+ puedes cargarlo al iniciar con `NODE_OPTIONS=--env-file=.env` (sintaxis según tu shell); sin `.env` el modo offline funciona directamente. En Node 20, exporta las variables de `.env` en tu entorno antes de iniciar. `LLM_PROVIDER` acepta `mock` (por defecto), `openai`, `anthropic` u `ollama`. `LLM_API_KEY` es necesaria para OpenAI y Anthropic; sin ella se activa `mock`. Ollama funciona localmente sin clave si el modelo está disponible. `LLM_MODEL` selecciona el modelo y `LLM_BASE_URL` cambia el endpoint base (OpenAI `/v1`, Anthropic `/v1`, Ollama raíz). Los valores por defecto ya están incorporados en el adaptador; configura explícitamente modelo/base según la instancia que uses. `PORT` define el puerto HTTP. Ninguna clave se envía al navegador. El modo online depende de un servicio LLM accesible y no es necesario para la demo.

## Reglas de negocio

- **RN1 — identificador extranjero:** el glosario resuelve NIT a la ruta exacta del maestro; para EC, PE, PA y HN se marca «identificador extranjero» y requiere confirmación. CO no lleva esa marca.
- **RN2 — información bancaria:** solo se diligencia cuando la plantilla pide esos campos; se excluye del borrador de correo. El formulario descargable sí puede contenerla si la plantilla la solicita.
- **RN3 — firma:** el checklist compara cada soporte exigido y su vigencia frente a la fecha de solicitud. Un soporte ausente o vencido bloquea `listo_para_firma`. Además, los campos obligatorios faltantes y la confirmación de identificador extranjero impiden que el estado final sea listo; los faltantes por sí solos no convierten un soporte presente en ausente.
- **RN4 — confirmación humana:** ni el modo offline ni el adaptador LLM invocan `proveedor_simular_envio` con `confirmado: true` sin un mensaje actual que apruebe explícitamente el envío e identifique el mismo caso. La simulación no envía correo real.
- **RN5 — trazabilidad:** cada herramienta registra `{ts, herramienta, ok, resumen}` y datos de paso/caso en `out/<caso>/log.jsonl`, incluso las invocaciones denegadas por la propia herramienta.

El formato `portal` se declara no soportado para automatización: genera `valores-portal.md` para copiar manualmente, sin navegar ni ingresar credenciales en un portal externo. Las sesiones conversacionales se guardan en memoria y se reinician al reiniciar el servidor.
