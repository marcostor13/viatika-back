import * as fs from 'fs'
import * as path from 'path'
import JSZip = require('jszip')
import { CONTANET_COLUMNS, ContanetLine, FIRST_DATA_COL_INDEX } from './contanet-columns'
import { AsientoTipo } from './accounting-entries.types'

export interface ContanetFile {
  buffer: Buffer
  ext: 'xlsm'
  contentType: string
}

const XLSM_CONTENT_TYPE =
  'application/vnd.ms-excel.sheet.macroEnabled.12'

// Un único template para todos los tipos: Contanet usa la misma plantilla
// base (mismas columnas/hojas) para compra/solicitud/aplicación/devolución/
// reembolso; los 3 archivos previos (compras/aplicacion/reembolso.xlsm) eran
// copias idénticas de esa misma plantilla, no formatos distintos.
const TEMPLATE_FILE =
  'F_Importacion_ModImportacion_ModContabilidad_Contabilidad.xlsm'

const TEMPLATE_MAP: Record<string, string> = {
  compra: TEMPLATE_FILE,
  aplicacion: TEMPLATE_FILE,
  solicitud: TEMPLATE_FILE,
  devolucion: TEMPLATE_FILE,
  reembolso: TEMPLATE_FILE,
}

export function resolveTemplatePath(tipo?: AsientoTipo): string | null {
  if (!tipo) return null
  const file = TEMPLATE_MAP[tipo]
  if (!file) return null
  // Assets compiled to dist/docs/asientos/ by nest-cli.json; fall back to src location for ts-node runs.
  const candidates = [
    path.join(process.cwd(), 'dist', 'docs', 'asientos', file),
    path.join(process.cwd(), 'src', 'docs', 'asientos', file),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

/** Bytes del template cacheados en memoria (se leen del disco una sola vez). */
const TEMPLATE_BUFFER_CACHE = new Map<string, Buffer>()

function readTemplateBuffer(templatePath: string): Buffer {
  const cached = TEMPLATE_BUFFER_CACHE.get(templatePath)
  if (cached) return cached
  const buffer = fs.readFileSync(templatePath)
  TEMPLATE_BUFFER_CACHE.set(templatePath, buffer)
  return buffer
}

// ---------------------------------------------------------------------------
// Punto de entrada: siempre el .xlsm IDÉNTICO al template de Contanet (macros,
// estilos y todas las hojas intactas). Se logra por "cirugía de ZIP": se abre
// el .xlsm, se reemplazan SOLO las filas de datos de la hoja CONTABILIDAD y se
// re-empaqueta dejando el resto byte-a-byte. No existe una ruta alterna en
// .xlsx: si el template no está disponible en el servidor, se lanza un error
// explícito en vez de degradar silenciosamente a un archivo con otra
// estructura (sin macros ni hojas TABLAS/ImportCONTABILIDAD).
// ---------------------------------------------------------------------------
export async function generateContanetExcel(
  lines: ContanetLine[],
  tipo: AsientoTipo | undefined
): Promise<ContanetFile> {
  const xlsm = await buildContanetXlsm(lines, tipo)
  if (!xlsm) {
    throw new Error(
      `No se encontró la plantilla Contanet (.xlsm) en el servidor para el tipo "${tipo}". ` +
      'Verifica que exista en src/docs/asientos/ (o dist/docs/asientos/ tras el build).'
    )
  }
  return { buffer: xlsm, ext: 'xlsm', contentType: XLSM_CONTENT_TYPE }
}

// ---------------------------------------------------------------------------
// .xlsm idéntico al template vía cirugía de ZIP
// ---------------------------------------------------------------------------

function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function escapeXml(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    // Descarta caracteres de control no v�lidos en XML 1.0 (permite tab/LF/CR).
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    const ch = s[i]
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else out += ch
  }
  return out
}

/** Resuelve la ruta interna de una hoja (por nombre) dentro del .xlsm. */
async function resolveSheetPath(
  zip: JSZip,
  sheetName: string
): Promise<string | null> {
  const wbXml = await zip.file('xl/workbook.xml')?.async('string')
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!wbXml || !relsXml) return null
  const sheetMatch = [
    ...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g),
  ].find(m => m[1] === sheetName)
  if (!sheetMatch) return null
  const rid = sheetMatch[2]
  const rel = [
    ...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g),
  ].find(m => m[1] === rid)
  if (!rel) return null
  const target = rel[2].replace(/^\//, '')
  return target.startsWith('xl/') ? target : `xl/${target}`
}

/** Parámetros de escritura de las filas de datos en una hoja del template. */
interface SheetWriteSpec {
  /** Fila (1-based) donde arranca la primera fila de datos. */
  firstDataRow: number
  /** Índice (0-based) de la primera columna de datos. */
  firstDataColIndex: number
  /** Valor del atributo `spans` de las filas generadas. */
  spans: string
  /** Ref de `<dimension>` a declarar, en función del nº de filas. */
  dimensionRef: (rowCount: number) => string
}

/**
 * Reemplaza las filas de datos de una hoja conservando todo lo demás
 * (cabeceras, estilos, mergeCells, drawings) tal cual viene del template.
 */
function replaceSheetDataRows(
  xml: string,
  lines: ContanetLine[],
  spec: SheetWriteSpec
): string | null {
  const sdOpen = xml.indexOf('<sheetData>')
  const sdClose = xml.indexOf('</sheetData>')
  if (sdOpen === -1 || sdClose === -1) return null
  const sdStart = sdOpen + '<sheetData>'.length

  // Estilos por columna tomados de la primera fila de datos del template
  // (fila modelo), para que las filas generadas hereden su formato exacto.
  const styleByCol: Record<string, string> = {}
  const modelRow = xml.match(
    new RegExp(`<row r="${spec.firstDataRow}"[^]*?</row>`)
  )
  if (modelRow) {
    const cellRe = new RegExp(
      `<c r="([A-Z]+)${spec.firstDataRow}"(?: s="(\\d+)")?`,
      'g'
    )
    for (const m of modelRow[0].matchAll(cellRe)) {
      styleByCol[m[1]] = m[2] || '0'
    }
  }

  // Cabeceras: todo lo que hay entre <sheetData> y la primera fila de datos.
  const modelRowStart = xml.indexOf(`<row r="${spec.firstDataRow}"`, sdStart)
  const headerEnd =
    modelRowStart !== -1 && modelRowStart < sdClose ? modelRowStart : sdClose
  const headerXml = xml.slice(sdStart, headerEnd)

  let rowsXml = ''
  lines.forEach((line, i) => {
    const rn = spec.firstDataRow + i
    let cells = ''
    CONTANET_COLUMNS.forEach((col, ci) => {
      const letter = colLetter(spec.firstDataColIndex + 1 + ci)
      const s = styleByCol[letter] || '0'
      const sAttr = s !== '0' ? ` s="${s}"` : ''
      const v = line[col.key]
      if (v === undefined || v === null || v === '') {
        cells += `<c r="${letter}${rn}"${sAttr}/>`
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        cells += `<c r="${letter}${rn}"${sAttr}><v>${v}</v></c>`
      } else {
        cells += `<c r="${letter}${rn}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(v))}</t></is></c>`
      }
    })
    rowsXml += `<row r="${rn}" spans="${spec.spans}">${cells}</row>`
  })

  const newXml = xml.slice(0, sdStart) + headerXml + rowsXml + xml.slice(sdClose)
  // Ajusta el rango declarado para cubrir las filas nuevas (Excel lo tolera laxo,
  // pero mantenerlo correcto evita advertencias de reparación).
  return newXml.replace(
    /<dimension ref="[A-Z]+\d+:[A-Z]+\d+"\/>/,
    `<dimension ref="${spec.dimensionRef(lines.length)}"/>`
  )
}

// CONTABILIDAD: hoja visible que llena el usuario. Datos en D9:BX{8+n}.
const CONTABILIDAD_SPEC: SheetWriteSpec = {
  firstDataRow: 9,
  firstDataColIndex: FIRST_DATA_COL_INDEX,
  spans: '2:77',
  dimensionRef: n => `A1:KQ${8 + n}`,
}

// ImportCONTABILIDAD: hoja oculta que Contanet lee de verdad. Datos en A2:BU{1+n}.
// Es un espejo 1:1 de CONTABILIDAD desplazado 3 columnas (D→A) y 7 filas (9→2).
const IMPORT_CONTABILIDAD_SPEC: SheetWriteSpec = {
  firstDataRow: 2,
  firstDataColIndex: 0,
  spans: `1:${CONTANET_COLUMNS.length}`,
  dimensionRef: n =>
    `A1:${colLetter(CONTANET_COLUMNS.length)}${1 + Math.max(n, 1)}`,
}

/**
 * Genera el .xlsm idéntico al template reemplazando solo las filas de datos.
 *
 * IMPORTANTE: Contanet NO importa desde la hoja visible CONTABILIDAD, sino
 * desde la hoja oculta ImportCONTABILIDAD. En el template esa hoja la llena la
 * macro `Workbook_BeforeSave` → `Procesar` → `transferirDatos "CONTABILIDAD",
 * "ImportCONTABILIDAD", "D", "9"`, que copia CONTABILIDAD!D9:BX{últimaFila}
 * sobre ImportCONTABILIDAD!A2. Por eso un archivo llenado a mano y guardado en
 * Excel sí sube (la macro corrió al guardar) y uno generado en el servidor no
 * (nadie ejecuta VBA). Aquí replicamos esa copia por código escribiendo AMBAS
 * hojas; si solo se escribe CONTABILIDAD, Contanet lee 0 filas y rechaza el
 * archivo.
 *
 * Devuelve null si no hay template para el tipo o el archivo no tiene la
 * estructura esperada; `generateContanetExcel` lo convierte en un error
 * explícito (no hay ruta alterna en .xlsx).
 */
export async function buildContanetXlsm(
  lines: ContanetLine[],
  tipo?: AsientoTipo
): Promise<Buffer | null> {
  const templatePath = resolveTemplatePath(tipo)
  if (!templatePath) return null

  const zip = await JSZip.loadAsync(readTemplateBuffer(templatePath))

  const targets: [string, SheetWriteSpec][] = [
    ['CONTABILIDAD', CONTABILIDAD_SPEC],
    ['ImportCONTABILIDAD', IMPORT_CONTABILIDAD_SPEC],
  ]

  for (const [sheetName, spec] of targets) {
    const sheetPath = await resolveSheetPath(zip, sheetName)
    if (!sheetPath || !zip.file(sheetPath)) return null
    const xml = await zip.file(sheetPath)!.async('string')
    const newXml = replaceSheetDataRows(xml, lines, spec)
    if (!newXml) return null
    zip.file(sheetPath, newXml)
  }

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  })
  return out
}
