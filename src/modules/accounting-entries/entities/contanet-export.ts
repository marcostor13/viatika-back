import {
  CONTANET_COLUMNS,
  ContanetLine,
  FIRST_DATA_COL_INDEX,
  COL_GRUPO,
  COL_OBLIGATORIO,
  COL_TIPO_DATO,
  COL_CARACTERES,
} from './contanet-columns'

/**
 * Construye la matriz (array de arrays) que replica la hoja `sheet1` del template
 * de Contanet: encabezados en filas 2-8 y datos a partir de la fila 9.
 * El índice 0 del arreglo exterior es la fila 1 (vacía).
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

/**
 * Genera un buffer .xlsx con una hoja "CONTABILIDAD" que replica sheet1.
 * Usa SheetJS (xlsx), ya presente en el backend.
 */
export async function buildContanetWorkbook(
  lines: ContanetLine[],
  sheetName = 'CONTABILIDAD'
): Promise<Buffer> {
  const xlsx = await import('xlsx')
  const aoa = buildContanetAoa(lines)
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, sheetName)
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}