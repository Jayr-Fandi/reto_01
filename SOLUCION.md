# Solución: registro conversacional de proveedores

## Arquitectura

La solución divide el flujo en cuatro capas. `modulo/` contiene las reglas y las cinco herramientas de negocio; `src/tools/proveedor.ts` solo reexporta esas herramientas. `src/llm/adapter.ts` define el contrato común de mensajes, llamadas y resultados, expone los cinco nombres `proveedor_*` y deriva sus JSON Schema directamente de Zod. `src/llm/provider.ts` implementa OpenAI, Anthropic, Ollama y Mock mediante el mismo contrato; `src/agent/llm.ts` queda como reexportación de compatibilidad. `src/agent/loop.ts` lleva las sesiones, invoca las herramientas y aplica la compuerta de confirmación. `src/server.ts` ofrece la API y sirve `web/` con el chat y el inspector.

El servidor usa el módulo HTTP de Node sin framework. Zod valida tanto las entradas de herramientas como la petición de chat; `strict: true`, `noImplicitAny` y `noUncheckedIndexedAccess` están activos. Los archivos generados viven bajo `out/<caso>/`, no en las carpetas de fixtures. Solo se sirve una lista cerrada de artefactos de casos conocidos; el servidor escucha en loopback y no tiene autenticación para exposición pública.

## `modulo/` como fuente única

`modulo/agent.md` y `modulo/skill/registro-proveedor/SKILL.md` son las fuentes de prompt y reglas. `npm run sync` mantiene sus vistas derivadas en `agent/prompt.md` y `src/knowledge/registro-proveedor.md`, que el bucle lee al atender conversaciones LLM. La implementación reside únicamente en `modulo/tools/proveedor.ts`: `src/tools/proveedor.ts` la reexporta sin copia ni divergencia.

## Cinco herramientas

1. `leer_solicitud` carga la solicitud, plantilla XLSX/PDF/portal y soportes exigidos, incluyendo términos reconocidos del cuerpo del mensaje.
2. `mapear_campos` cruza etiquetas con glosario y rutas exactas del maestro; retorna llenos, faltantes y valores por confirmar sin inventar datos.
3. `generar_formulario` comprueba el mapeo contra el maestro y genera XLSX en las hojas/celdas indicadas, PDF en orden de plantilla, o una lista Markdown para portales no automatizados.
4. `armar_paquete` copia el formulario y los soportes físicos disponibles, clasifica vigencias, prepara checklist y borrador de correo.
5. `simular_envio` requiere `confirmado: true` y un borrador previo; registra un archivo de simulación, sin enviar correo.

Cada `execute` valida sus argumentos con Zod, devuelve un resultado JSON serializado y escribe una línea en `out/<caso>/log.jsonl`. El bucle conversacional ofrece modo offline cuando falta clave o se selecciona `mock`; en modo online adapta las llamadas de herramientas del proveedor al contrato común.

## Reglas de negocio

- **RN1:** el identificador local CO es NIT, EC/PE/PA es RUC y HN es RTN. Para país extranjero se usa el NIT del maestro con nota literal «identificador extranjero» y confirmación requerida.
- **RN2:** los datos bancarios aparecen únicamente si la plantilla los solicita; nunca figuran en el borrador de correo.
- **RN3:** el checklist compara la fecha de expiración de cada soporte con la fecha de la solicitud. Un soporte ausente o vencido bloquea la firma; un campo obligatorio faltante o una confirmación pendiente también dejan el estado final en revisión. Un campo faltante no cambia la clasificación de los soportes.
- **RN4:** el bucle solo permite simular el envío cuando el mensaje actual aprueba explícitamente el envío e indica el mismo caso. La herramienta exige además el booleano `confirmado: true`; ninguna ruta envía correo real.
- **RN5:** cada ejecución de herramienta deja un evento JSONL con fecha, nombre, resultado y resumen; el inspector permite consultarlo.

## Supuestos y limitaciones

Los cuatro casos, maestro, glosario e índice de soportes son los fixtures de `fixtures/reto-01/`. Las plantillas JSON describen la salida; no se modifica el archivo original adjunto. Para PDF se genera un documento nuevo con etiquetas y valores (los caracteres fuera de la fuente estándar se transliteran). Portal produce valores para copiar, sin interactuar con credenciales ni páginas externas. El envío es solo simulado y las sesiones de chat permanecen en memoria hasta reiniciar el servidor. Los proveedores externos requieren sus servicios y credenciales; la ejecución reproducible de los cuatro casos se realiza sin API key con `npm run demo` y el modo Mock.
