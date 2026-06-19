import { IsString, IsNumber, IsOptional, IsMongoId, Min } from 'class-validator'

/**
 * Registro de un pago directo de Contabilidad. Genera un Saldo tipo `pago`
 * (sin centro de costo) para el colaborador destino.
 */
export class CreatePagoSaldoDto {
  @IsMongoId()
  userId: string // colaborador destino

  @IsNumber()
  @Min(0.01)
  amount: number // monto confirmado del depósito

  @IsNumber()
  @IsOptional()
  scannedAmount?: number // monto crudo del OCR (auditoría)

  @IsString()
  receiptUrl: string

  @IsString()
  @IsOptional()
  receiptFileName?: string

  @IsString()
  @IsOptional()
  receiptMimeType?: string

  @IsNumber()
  @IsOptional()
  receiptSizeBytes?: number

  @IsString()
  @IsOptional()
  depositDate?: string

  // Datos extraídos del comprobante (OCR/visión)
  @IsString()
  @IsOptional()
  operationNumber?: string

  @IsString()
  @IsOptional()
  operationDate?: string

  @IsString()
  @IsOptional()
  operationTime?: string

  @IsString()
  @IsOptional()
  titular?: string
}
