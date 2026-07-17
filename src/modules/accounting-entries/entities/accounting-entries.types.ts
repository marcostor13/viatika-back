import { ContanetLine } from './contanet-columns'

export type AsientoTipo =
  | 'solicitud'
  | 'compra'
  | 'aplicacion'
  | 'devolucion'
  | 'reembolso'

/** Resultado de validar el cuadre de un lote de asientos. */
export interface CuadreError {
  relacionado: number
  totalDebe: number
  totalHaber: number
  diferencia: number
  /** Fila de Excel (1-indexed) de la primera/última línea de este asiento en el .xlsx generado. */
  filaInicio?: number
  filaFin?: number
  /** Descripción legible del comprobante/anticipo (razón social + serie-número, o glosa). */
  documento?: string
}

export interface AsientoLote {
  tipo: AsientoTipo
  /** Líneas listas para exportar (ya con correlativo y relacionado). */
  lines: ContanetLine[]
  /** Errores de cuadre detectados (vacío si todo cuadra). */
  cuadreErrors: CuadreError[]
}

export type AccountingEntriesStatus = 'processing' | 'ready' | 'error'

/** Estado de un tipo de asiento expuesto al frontend. */
export interface AccountingEntryStatusDto {
  tipo: AsientoTipo
  /** 'none' = nunca generado. */
  status: AccountingEntriesStatus | 'none'
  filename?: string
  /** URL firmada de descarga (S3), válida por pocos minutos. Solo si hay un archivo listo. */
  url?: string
  asientosCount?: number
  cuadreErrors?: CuadreError[]
  /** Avisos de configuración (ej. categoría sin cuenta 9X) detectados al generar. */
  warnings?: string[]
  errorMessage?: string
  /** El archivo listo ya no refleja el estado actual de la rendición. */
  stale?: boolean
  completedAt?: Date
  /**
   * Reservado para un futuro bloqueo de generación. Actualmente siempre `false`:
   * todos los tipos de asiento se pueden generar sin importar el estado de la
   * rendición (ya no existe la restricción "solo si está cerrada").
   */
  blocked?: boolean
  /** Motivo del bloqueo, para mostrar al usuario. */
  blockedReason?: string
}
