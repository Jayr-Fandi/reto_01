# Knowledge: Registro de Proveedor

> **Fuente única de verdad.** Las reglas de negocio viven en
> [`../../../modulo/skill/registro-proveedor/SKILL.md`](../../../modulo/skill/registro-proveedor/SKILL.md).
> Este archivo **no** las duplica: las reutiliza tal cual. Edita el SKILL.md y
> este archivo lo refleja. No agregues ni reescribas reglas aquí para evitar
> copias divergentes.

Contenido vigente (incluido tal cual desde
`modulo/skill/registro-proveedor/SKILL.md`):

<!-- INICIO: contenido reutilizado de modulo/skill/registro-proveedor/SKILL.md -->
---
name: registro-proveedor
description: Reglas de negocio para diligenciar formatos de alta de proveedor (XLSX con celdas etiquetadas, PDF con campos, portal en linea) con datos del maestro de Periferia IT Group, mapear el identificador tributario por pais (CO->NIT, EC/PE/PA->RUC, HN->RTN), validar la vigencia de soportes, bloquear listo_para_firma cuando falta o vencio un soporte y preparar el correo de respuesta (sin datos bancarios) sujeto a confirmacion humana.
---

# Skill: Registro de Proveedor

Reglas de negocio del agente de registro de proveedor. Se aplican tal cual y
tienen prioridad sobre cualquier atajo. Fuente de datos: `fixtures/reto-01/`.

## 1. Entradas del caso

Cada caso vive en `casos/<id>/` y trae:

- `solicitud.json`: `id`, `de`, `para`, `asunto`, `fecha`, `pais`, `cliente`,
  `formato` (`xlsx` | `pdf` | `portal`), `cuerpo` (soportes pedidos en prosa),
  `adjuntos`.
- `plantilla-celdas.json` (formato `xlsx`): lista de `{hoja, celda_etiqueta,
  etiqueta, celda_valor}`.
- `plantilla-campos.json` (formatos `pdf` | `portal`): lista de `{etiqueta,
  obligatorio}`.
- `soportes-exigidos.json`: tipos de soporte exigidos por el cliente.

Datas maestras comunes a todo caso:

- `repositorio/maestro.json`: datos de Periferia.
- `glosario-campos.json`: traduce la etiqueta del cliente a campo canónico.
- `repositorio/soportes/index.json`: soportes disponibles con `vigencia_hasta`
  y `pais_emisor`.

## 2. Mapeo de etiqueta a campo canónico (glosario)

Para cada etiqueta de la plantilla, busca su equivalente en
`glosario-campos.json` y toma el valor del maestro. Si la etiqueta **no** está
en el glosario, el campo queda `faltante` (no se deduce).

Ejemplos del glosario:

- `Razón social`, `Nombre de la empresa`,
  `Nombre o razón social del proveedor` → `razon_social`.
- `NIT`, `RUC`, `RTN`, `Identificación tributaria`,
  `Número de identificación fiscal` → `nit`.
- `Domicilio fiscal` → `direccion`; `País` → `pais`.
- `Correo electrónico` → `contacto_comercial.email`;
  `Correo de facturación` → `contacto_financiero.email`.
- `Banco` → `banco.nombre`; `Número de cuenta` → `banco.numero_cuenta`;
  `SWIFT` → `banco.swift`.

## 3. Identificador tributario por país

El campo canónico siempre es `nit`; la **etiqueta local** depende del país del
proveedor:

| País | Etiqueta del identificador | Origen |
|------|----------------------------|--------|
| CO   | NIT                        | Local |
| EC   | RUC                        | Local |
| PE   | RUC                        | Local |
| PA   | RUC                        | Local |
| HN   | RTN                        | Local |

Reglas:

- Para **CO** el identificador es local: se toma `nit` del maestro tal cual, sin
  nota ni confirmación (`requiere_confirmacion: false`).
- Para **EC, PE, PA, HN** (proveedor **extranjero**, país ≠ CO) el valor del
  maestro se reporta como el identificador tributario local junto con la nota
  literal **"identificador extranjero"** y `requiere_confirmacion: true`. Un
  proveedor extranjero nunca alcanza `listo_para_firma` sin confirmación humana.
- El dígito de verificación (CO) solo aplica cuando la plantilla trae el campo
  `Dígito de verificación`.

## 4. Datos bancarios

- Los datos bancarios se diligencian **solo si la plantilla los pide**, es decir
  si trae etiquetas de banco (`Banco`, `Tipo de cuenta`, `Número de cuenta`,
  `Titular de la cuenta`, `SWIFT`). Si la plantilla no los pide, no se agregan.
- Los datos bancarios **nunca** se incluyen en el correo de respuesta al
  cliente, aunque la plantilla o el cuerpo del correo los mencionen.
- El formato (`xlsx`/`pdf`) puede llevarlos; el correo no.

## 5. Validación de soportes y bloqueo de `listo_para_firma`

Cruza los soportes exigidos (`soportes-exigidos.json` y lo pedido en el
`cuerpo`) contra `repositorio/soportes/index.json`, usando la `fecha` de la
solicitud como referencia. Cada soporte queda en uno de estos estados:

- `presente`: existe en el índice y su `vigencia_hasta` es `null` o posterior a
  la fecha de la solicitud.
- `vencido`: existe, tiene `vigencia_hasta` y esa fecha ya pasó respecto de la
  fecha de la solicitud.
- `ausente`: no existe en el índice.

**Bloqueo obligatorio.** `listo_para_firma` se bloquea si hay **al menos un
soporte vencido o ausente**. En ese caso el estado del caso es
`requiere_revision` y cada soporte bloqueante se lista en `bloqueos`. Solo se
alcanza `listo_para_firma` cuando todos los soportes exigidos están `presente`,
no hay campos obligatorios `faltante` y el identificador no requiere
confirmación.

## 6. Confirmación humana antes de enviar

- El agente **nunca** envía un correo por su cuenta. Siempre deja un borrador
  (`correo_borrador`) y espera confirmación humana explícita.
- El envío se realiza únicamente después de que una persona apruebe el borrador.
  Este requisito es independiente del estado del caso: aplica incluso a
  `listo_para_firma`.
- El borrador se redacta con los datos resueltos del maestro, cita los soportes
  entregados y no incluye datos bancarios.

## 7. Logs

- Toda ejecución escribe su traza en `out/<caso>/log.jsonl` (una línea por
  evento, cada línea un objeto JSON válido, sin envoltorio de array).
- Cada evento incluye al menos: `ts`, `caso`, `paso`, `accion`, `detalle` y,
  cuando aplique, `estado` y `motivo`.
- Se registran entradas leídas, campos resueltos, faltantes, resultado de la
  validación de soportes, bloqueos, el estado final y la decisión de envío.

## 8. Estructura de salida del caso

```json
{
  "caso": "<id>",
  "pais": "CO | EC | PE | PA | HN",
  "cliente": "<cliente>",
  "formato": "xlsx | pdf | portal",
  "estado": "listo_para_firma | requiere_revision",
  "requiere_confirmacion": true,
  "campos": [
    { "etiqueta": "<etiqueta cliente>", "campo": "<campo canonico>",
      "valor": "<valor o null>", "obligatorio": true,
      "estado": "ok | faltante" }
  ],
  "identificador_tributario": {
    "etiqueta": "NIT | RUC | RTN", "valor": "<valor>",
    "nota": "identificador extranjero | null",
    "requiere_confirmacion": false
  },
  "soportes": [
    { "tipo": "<tipo>", "estado": "presente | ausente | vencido",
      "vigencia_hasta": "<fecha o null>" }
  ],
  "bloqueos": ["<motivo>"],
  "correo_borrador": { "para": "<email>", "asunto": "<asunto>",
    "cuerpo": "<cuerpo sin datos bancarios>" }
}
```

## 9. Principios

- No inventar datos: todo valor sale del maestro vía el glosario.
- Determinista y auditable: mismas entradas, mismo resultado y misma traza.
- Ante duda de vigencia o de identificador, bloquear y pedir confirmación antes
  que firmar o enviar.
<!-- FIN: contenido reutilizado de modulo/skill/registro-proveedor/SKILL.md -->