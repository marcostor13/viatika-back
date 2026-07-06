import * as fs from 'fs'
import * as path from 'path'
import * as ExcelJS from 'exceljs'
import JSZip = require('jszip')
import {
  CONTANET_COLUMNS,
  ContanetLine,
  FIRST_DATA_COL_INDEX,
  COL_GRUPO,
  COL_OBLIGATORIO,
  COL_TIPO_DATO,
  COL_CARACTERES,
} from './contanet-columns'
import { AsientoTipo } from './accounting-entries.types'

/** Formato de salida del archivo de asientos, configurable por empresa. */
export type ExcelOutputMode = 'template' | 'styled'

export interface ContanetFile {
  buffer: Buffer
  ext: 'xlsx' | 'xlsm'
  contentType: string
}

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLSM_CONTENT_TYPE =
  'application/vnd.ms-excel.sheet.macroEnabled.12'

const TEMPLATE_MAP: Record<string, string> = {
  compra: 'compras.xlsm',
  aplicacion: 'aplicacion.xlsm',
  solicitud: 'aplicacion.xlsm',
  devolucion: 'reembolso.xlsm',
  reembolso: 'reembolso.xlsm',
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

/**
 * Construye la matriz (array de arrays) que replica la hoja `sheet1` del template
 * de Contanet: encabezados en filas 2-8 y datos a partir de la fila 9.
 * El índice 0 del arreglo exterior es la fila 1 (vacía).
 * Usado como fallback cuando no hay template disponible.
 */
export function buildContanetAoa(lines: ContanetLine[]): (string | number)[][] {
  const totalCols = FIRST_DATA_COL_INDEX + CONTANET_COLUMNS.length
  const emptyRow = (): (string | number)[] => new Array(totalCols).fill('')

  const aoa: (string | number)[][] = []

  // Fila 1: vacía
  aoa.push(emptyRow())

  // Fila 2: zona a importar
  const row2 = emptyRow()
  row2[1] = 'Zona Límite a  Importar' // B
  row2[2] = 'CONTABILIDAD' // C
  aoa.push(row2)

  // Fila 3: información obligatoria (marca «(*)» por columna)
  const row3 = emptyRow()
  row3[2] = 'Información Obligatoria'
  CONTANET_COLUMNS.forEach((c, i) => {
    if (COL_OBLIGATORIO.has(c.key)) row3[FIRST_DATA_COL_INDEX + i] = '(*)'
  })
  aoa.push(row3)

  // Fila 4: tipo de dato por columna
  const row4 = emptyRow()
  row4[2] = 'Tipo de Dato'
  CONTANET_COLUMNS.forEach((c, i) => {
    row4[FIRST_DATA_COL_INDEX + i] = COL_TIPO_DATO[c.key] ?? 'Texto'
  })
  aoa.push(row4)

  // Fila 5: cantidad de caracteres por columna
  const row5 = emptyRow()
  row5[2] = 'Cantidad Caracteres'
  CONTANET_COLUMNS.forEach((c, i) => {
    const v = COL_CARACTERES[c.key]
    if (v !== undefined) row5[FIRST_DATA_COL_INDEX + i] = v
  })
  aoa.push(row5)

  // Fila 6: descripción / grupos (etiqueta al inicio de cada grupo)
  const row6 = emptyRow()
  row6[2] = 'Descripción'
  CONTANET_COLUMNS.forEach((c, i) => {
    if (COL_GRUPO[c.key]) row6[FIRST_DATA_COL_INDEX + i] = COL_GRUPO[c.key]
  })
  aoa.push(row6)

  // Fila 7: encabezados amigables
  const row7 = emptyRow()
  CONTANET_COLUMNS.forEach((c, i) => {
    row7[FIRST_DATA_COL_INDEX + i] = c.h7
  })
  aoa.push(row7)

  // Fila 8: encabezados técnicos
  const row8 = emptyRow()
  CONTANET_COLUMNS.forEach((c, i) => {
    row8[FIRST_DATA_COL_INDEX + i] = c.h8
  })
  aoa.push(row8)

  // Filas 9+: datos
  for (const line of lines) {
    const row = emptyRow()
    CONTANET_COLUMNS.forEach((c, i) => {
      const v = line[c.key]
      row[FIRST_DATA_COL_INDEX + i] = v === undefined || v === null ? '' : v
    })
    aoa.push(row)
  }

  return aoa
}

// ---------------------------------------------------------------------------
// Punto de entrada: elige la solución según la configuración de la empresa.
// ---------------------------------------------------------------------------

/**
 * Genera el archivo de asientos en el formato configurado por la empresa:
 *
 *  - `template`: **.xlsm IDÉNTICO al template** de Contanet (macros, estilos y
 *    todas las hojas intactas). Se logra por "cirugía de ZIP": se abre el .xlsm,
 *    se reemplazan SOLO las filas de datos de la hoja CONTABILIDAD y se re-empaqueta
 *    dejando el resto byte-a-byte. Rápido (~90 ms) porque NO re-serializa la hoja
 *    basura de 16k columnas ni el binario de macros.
 *
 *  - `styled` (por defecto): **.xlsx liviano con cabeceras estilizadas** (negrita,
 *    fondo, bordes) generado desde cero con ExcelJS. Sin macros ni hoja basura.
 *    Muy rápido (~30 ms). Mismos datos y estructura que sheet1.
 *
 * Ambos son ~100x más rápidos que la vieja ruta de cargar el template con ExcelJS
 * (que costaba 8-15 s por tipo por re-serializar la hoja de 16k columnas).
 */
export async function generateContanetExcel(
  lines: ContanetLine[],
  tipo: AsientoTipo | undefined,
  mode: ExcelOutputMode
): Promise<ContanetFile> {
  if (mode === 'template') {
    const xlsm = await buildContanetXlsm(lines, tipo)
    if (xlsm) return { buffer: xlsm, ext: 'xlsm', contentType: XLSM_CONTENT_TYPE }
    // Sin template disponible → cae a la ruta estilizada (no rompe la generación).
  }
  const buffer = await buildContanetStyledXlsx(lines)
  return { buffer, ext: 'xlsx', contentType: XLSX_CONTENT_TYPE }
}

// ---------------------------------------------------------------------------
// Solución "styled": .xlsx liviano con cabeceras estilizadas (ExcelJS desde cero)
// ---------------------------------------------------------------------------

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EDF3' },
}
const HEADER_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFB8C4D0' } },
  bottom: { style: 'thin', color: { argb: 'FFB8C4D0' } },
  left: { style: 'thin', color: { argb: 'FFB8C4D0' } },
  right: { style: 'thin', color: { argb: 'FFB8C4D0' } },
}

export async function buildContanetStyledXlsx(
  lines: ContanetLine[],
  sheetName = 'CONTABILIDAD'
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  const aoa = buildContanetAoa(lines)
  // addRow por fila: aoa[0] = fila 1, cada arreglo arranca en la columna A.
  for (const rowArr of aoa) ws.addRow(rowArr)

  // Estilo de cabeceras (filas 2-8): negrita, fondo, bordes, centrado.
  for (let r = 2; r <= 8; r++) {
    const row = ws.getRow(r)
    row.eachCell({ includeEmpty: false }, cell => {
      cell.font = { bold: true, size: 9 }
      cell.fill = HEADER_FILL
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      cell.border = HEADER_BORDER
    })
  }
  ws.views = [{ state: 'frozen', ySplit: 8 }]

  const raw = await wb.xlsx.writeBuffer()
  return Buffer.from(raw as ArrayBuffer)
}

// ---------------------------------------------------------------------------
// Solución "template": .xlsm idéntico vía cirugía de ZIP
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
 * la hoja CONTABILIDAD. Devuelve null si no hay template para el tipo (el
 * dispatcher cae entonces a la ruta estilizada).
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
