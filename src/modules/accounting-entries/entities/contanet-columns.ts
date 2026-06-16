/**
 * Definición de columnas del archivo de importación de Contanet (replica de sheet1).
 * Las columnas de datos arrancan en la columna D de la hoja (A, B, C quedan vacías
 * en las filas de datos). El orden de este arreglo ES el orden de columnas D, E, F…
 *
 * Cada entrada: { key, h7, h8 }
 *  - key: identificador interno usado al construir cada línea de asiento.
 *  - h7:  encabezado "amigable" (fila 7 del template).
 *  - h8:  encabezado técnico (fila 8 del template).
 *
 * Fuente: viatika-back/docs/asientos/{compras,aplicacion,reembolso}.xlsm
 */
export interface ContanetColumn {
  key: string
  h7: string
  h8: string
}

/** Índice (0-based) de la primera columna de datos: D = 3 (A=0, B=1, C=2). */
export const FIRST_DATA_COL_INDEX = 3

export const CONTANET_COLUMNS: ContanetColumn[] = [
  { key: 'correlativo', h7: 'Correlativo', h8: 'Correlativo' },
  { key: 'relacionado', h7: 'Relacionado', h8: 'Relacionado' },
  { key: 'codMedioPago', h7: 'Cod. Tipo Medio Pago (Tabla 6)', h8: 'Codigo Tipo Medio Pago' },
  { key: 'ejercicio', h7: 'Ejercicio', h8: 'Ejercicio' },
  { key: 'periodo', h7: 'Periodo', h8: 'Periodo' },
  { key: 'codModulo', h7: 'Cod. Modulo', h8: 'Cod_MR' },
  { key: 'modulo', h7: 'Modulo', h8: 'Modulo' },
  { key: 'fuente', h7: 'Fuente', h8: 'Fuente' },
  { key: 'nroCuenta', h7: 'Nro. Cuenta', h8: 'Numero Cuenta' },
  { key: 'codTipDoc', h7: 'Cod. Tip. Doc.', h8: 'Codigo Tipo Document' },
  { key: 'nroSerie', h7: 'Nro. Sre.', h8: 'Numero Serie' },
  { key: 'nroDoc', h7: 'Nro. Doc.', h8: 'Numero Documento' },
  { key: 'conceptoFec', h7: 'Concepto FEC (Tabla 8)', h8: '' },
  { key: 'glosa', h7: 'Glosa', h8: 'Glosa' },
  { key: 'mdaOrigen', h7: 'Cod. Mda. Origen (Tabla 3)', h8: 'Codigo Moneda Origen' },
  { key: 'mdaRegistro', h7: 'Cod. Mda. Registro (Tabla 3)', h8: 'Codigo Moneda Registro' },
  { key: 'centroCosto', h7: 'Cod. Centro C.', h8: 'Codigo Centro Costo' },
  { key: 'subCentroCosto', h7: 'Cod. Sub. Centro C.', h8: 'Codigo Sub Centro Costo' },
  { key: 'subSubCentroCosto', h7: 'Cod. Sub. Sub. Centro C.', h8: 'Codigo Sub Sub Centro Costo' },
  { key: 'formaProvision', h7: 'Cod. Forma Provisión (Sistema)', h8: 'Codigo Forma Prov' },
  { key: 'formaPagoCobro', h7: 'Cod. Forma Pago/Cobro (Tabla 5)', h8: 'Codigo Forma Pago/Cobro' },
  { key: 'area', h7: 'Cod. Area', h8: 'Codigo Area' },
  { key: 'identCtrMda', h7: 'Identificador Ctr Mda.', h8: 'Identificador Ctr Mda' },
  { key: 'identTipAfecto', h7: 'Identificador Tip. Afecto', h8: 'Identificador Tip Afecto' },
  { key: 'nroCheque', h7: 'Nro. Cheque', h8: 'Nro Cheque' },
  { key: 'grdo', h7: 'Grdo', h8: 'Grdo' },
  { key: 'fechaEmision', h7: 'Fecha Emision Doc.', h8: 'Fecha Emision Doc' },
  { key: 'fechaVencimiento', h7: 'Fecha Vencimiento Doc.', h8: 'Fecha Vencimiento Doc' },
  { key: 'fechaMovimiento', h7: 'Fecha Movimiento', h8: 'Fecha Movimiento' },
  { key: 'fechaCbr', h7: 'Fecha Cbr.', h8: 'Fecha Cbr' },
  { key: 'fechaRegistro', h7: 'Fecha Registro', h8: 'Fecha Registro' },
  { key: 'fechaConc', h7: 'Fecha Conc.', h8: 'Fecha Conc' },
  { key: 'fechaDif', h7: 'Fecha Dif.', h8: 'Fecha Dif' },
  { key: 'codTipDocIdentClt', h7: 'Cod. Tip. Doc. Ident. Clt.', h8: 'Cod Tip Doc Ident Clt' },
  { key: 'nroDocClt', h7: 'Nro. Doc. Clt.', h8: 'Nro Doc Clt' },
  { key: 'razonSocialClt', h7: 'Razón Social 1', h8: 'Razón Social 1' },
  { key: 'codTipDocIdentProv', h7: 'Cod. Tip. Doc. Ident. Prov.', h8: 'Cod Tip Doc Ident Prov' },
  { key: 'nroDocProv', h7: 'Nro. Doc. Prov.', h8: 'Nro Doc Prov' },
  { key: 'razonSocialProv', h7: 'Razón Social 2', h8: 'Razón Social 1' },
  { key: 'codTipDocIdentTrab', h7: 'Cod. Tip. Doc. Ident. Trab.', h8: 'Cod Tip Doc Ident Trab' },
  { key: 'nroDocTrab', h7: 'Nro. Doc. Trab.', h8: 'Nro Doc Trab' },
  { key: 'razonSocialTrab', h7: 'Razón Social 3', h8: 'Razón Social 1' },
  { key: 'montoDebe', h7: 'Monto Debe', h8: 'Monto Debe' },
  { key: 'montoHaber', h7: 'Monto Haber', h8: 'Monto Haber' },
  { key: 'montoDebeME', h7: 'Monto Debe ME', h8: 'Monto Debe ME' },
  { key: 'montoHaberME', h7: 'Monto Haber ME', h8: 'Monto Haber ME' },
  { key: 'cambioMoneda', h7: 'Cambio Moneda', h8: 'Cambio Moneda' },
  { key: 'esCancelado', h7: '¿Es Cancelado?', h8: '¿Es Cancelado?' },
  { key: 'esConciliado', h7: '¿Es Conciliado?', h8: '¿Es Conciliado?' },
  { key: 'esProvision', h7: '¿Es Provision?', h8: '¿Es Provision?' },
  { key: 'esAnulado', h7: '¿Es Anulado?', h8: '¿Es Anulado?' },
  { key: 'esDestino', h7: '¿Es Destino?', h8: '¿Es Destino?' },
  { key: 'docRefFechaEmision', h7: 'Doc. Ref. Fecha Emision', h8: 'Doc Ref Fecha Emision' },
  { key: 'docRefCodTipDoc', h7: 'Doc. Ref. Cod. Tip. Doc.', h8: 'Doc Ref Cod Tip Doc' },
  { key: 'docRefNroSerie', h7: 'Doc. Ref. Nro. Serie', h8: 'Doc Ref Nro Serie' },
  { key: 'docRefNroDoc', h7: 'Doc. Ref. Nro. Doc.', h8: 'Doc Ref Nro Doc' },
  { key: 'nroDetraccion', h7: 'Número Detracción', h8: '' },
  { key: 'fechaPagoDetraccion', h7: 'Fecha Pago Detracción', h8: '' },
  { key: 'ca1', h7: 'CA 1', h8: 'CA01' },
  { key: 'ca2', h7: 'CA 2', h8: 'CA02' },
  { key: 'ca3', h7: 'CA 3', h8: 'CA03' },
  { key: 'ca4', h7: 'CA 4', h8: 'CA04' },
  { key: 'ca5', h7: 'CA 5', h8: 'CA05' },
  { key: 'ca6', h7: 'CA 6', h8: 'CA06' },
  { key: 'ca7', h7: 'CA 7', h8: 'CA07' },
  { key: 'ca8', h7: 'CA 8', h8: 'CA08' },
  { key: 'ca9', h7: 'CA 9', h8: 'CA09' },
  { key: 'ca10', h7: 'CA 10', h8: 'CA10' },
  { key: 'ca11', h7: 'CA 11', h8: 'CA11' },
  { key: 'ca12', h7: 'CA 12', h8: 'CA12' },
  { key: 'ca13', h7: 'CA 13', h8: 'CA13' },
  { key: 'ca14', h7: 'CA 14', h8: 'CA14' },
  { key: 'ca15', h7: 'CA 15', h8: 'CA15' },
]

/** Tipo de una línea de asiento: valores por columna (key → valor). */
export type ContanetLine = Record<string, string | number | undefined>

/** Convierte una fecha a número de serie de Excel (base 1899-12-30). */
export function toExcelSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30)
  const utc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  )
  return Math.round((utc - epoch) / 86400000)
}