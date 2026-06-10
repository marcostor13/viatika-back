import {
  IsString,
  IsNumber,
  IsOptional,
  IsMongoId,
  Min,
} from 'class-validator'

/**
 * Creación de una rendición directa con depósito inicial, iniciada por Contabilidad.
 * El usuario destino (colaborador/coordinador) recibe el saldo disponible.
 */
export class CreateDirectaDepositDto {
  @IsMongoId()
  userId: string // colaborador/coordinador destino

  @IsString()
  @IsOptional()
  gestion?: string

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
}
