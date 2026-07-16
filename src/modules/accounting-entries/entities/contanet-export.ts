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

/** Resuelve la ruta interna de la hoja "CONTABILIDAD" dentro del .xlsm. */
async function resolveContabilidadSheet(zip: JSZip): Promise<string | null> {
  const wbXml = await zip.file('xl/workbook.xml')?.async('string')
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!wbXml || !relsXml) return null
  const sheetMatch = [
    ...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g),
  ].find(m => m[1] === 'CONTABILIDAD')
  if (!sheetMatch) return null
  const rid = sheetMatch[2]
  const rel = [
    ...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g),
  ].find(m => m[1] === rid)
  if (!rel) return null
  const target = rel[2].replace(/^\//, '')
  return target.startsWith('xl/') ? target : `xl/${target}`
}

/**
 * Genera el .xlsm idéntico al template reemplazando solo las filas de datos de
 * la hoja CONTABILIDAD. Devuelve null si no hay template para el tipo o el
 * archivo no tiene la estructura esperada; `generateContanetExcel` lo
 * convierte en un error explícito (no hay ruta alterna en .xlsx).
 */
export async function buildContanetXlsm(
  lines: ContanetLine[],
  tipo?: AsientoTipo
): Promise<Buffer | null> {
  const templatePath = resolveTemplatePath(tipo)
  if (!templatePath) return null

  const zip = await JSZip.loadAsync(readTemplateBuffer(templatePath))
  const sheetPath = await resolveContabilidadSheet(zip)
  if (!sheetPath || !zip.file(sheetPath)) return null

  const xml = await zip.file(sheetPath)!.async('string')
  const sdOpen = xml.indexOf('<sheetData>')
  const sdClose = xml.indexOf('</sheetData>')
  if (sdOpen === -1 || sdClose === -1) return null
  const sdStart = sdOpen + '<sheetData>'.length

  // Estilos por columna tomados de la fila 9 del template (fila de datos modelo),
  // para que las filas generadas hereden el formato exacto de las celdas de datos.
  const styleByCol: Record<string, string> = {}
  const row9 = xml.match(/<row r="9"[\s\S]*?<\/row>/)
  if (row9) {
    for (const m of row9[0].matchAll(/<c r="([A-Z]+)9"(?: s="(\d+)")?/g)) {
      styleByCol[m[1]] = m[2] || '0'
    }
  }

  // Cabeceras: todo lo que hay entre <sheetData> y la primera fila de datos (9).
  const row9Start = xml.indexOf('<row r="9"', sdStart)
  const headerEnd = row9Start !== -1 && row9Start < sdClose ? row9Start : sdClose
  const headerXml = xml.slice(sdStart, headerEnd)

  // Filas de datos nuevas (9+), con el estilo por columna del template.
  let rowsXml = ''
  lines.forEach((line, i) => {
    const rn = 9 + i
    let cells = ''
    CONTANET_COLUMNS.forEach((col, ci) => {
      const letter = colLetter(FIRST_DATA_COL_INDEX + 1 + ci)
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
    rowsXml += `<row r="${rn}" spans="2:77">${cells}</row>`
  })

  let newXml = xml.slice(0, sdStart) + headerXml + rowsXml + xml.slice(sdClose)
  // Ajusta el rango declarado para cubrir las filas nuevas (Excel lo tolera laxo,
  // pero mantenerlo correcto evita advertencias de reparación).
  newXml = newXml.replace(
    /<dimension ref="[A-Z]+\d+:[A-Z]+\d+"\/>/,
    `<dimension ref="A1:KQ${8 + lines.length}"/>`
  )

  zip.file(sheetPath, newXml)
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  })
  return out
}
