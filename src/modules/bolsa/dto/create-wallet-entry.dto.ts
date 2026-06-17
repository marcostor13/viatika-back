import {
  IsString,
  IsNumber,
  IsMongoId,
  IsOptional,
  IsIn,
  Min,
} from 'class-validator'
import {
  WalletEntryOrigin,
  WalletEntryType,
} from '../entities/wallet-entry.entity'

/**
 * Carga de un saldo en la Bolsa de un colaborador. Se usa para la carga manual
 * de saldos previos de la marcha blanca (BOLSA-11); el resto del flujo crea
 * entradas internamente desde el servicio (depósito → Bolsa, sobrante → Bolsa).
 */
export class CreateWalletEntryDto {
  @IsMongoId()
  userId: string

  @IsMongoId()
  @IsOptional()
  clientId?: string

  @IsMongoId()
  @IsOptional()
  projectId?: string

  @IsIn(['viaticos', 'directa', 'caja_chica'])
  type: WalletEntryType

  @IsIn(['deposito', 'saldo_sobrante', 'carga_manual'])
  @IsOptional()
  origin?: WalletEntryOrigin

  @IsNumber()
  @Min(0.01)
  amount: number

  @IsMongoId()
  @IsOptional()
  sourceReportId?: string

  @IsMongoId()
  @IsOptional()
  sourceAdvanceId?: string

  @IsString()
  @IsOptional()
  sourceCodigo?: string

  @IsString()
  @IsOptional()
  operationNumber?: string

  @IsString()
  @IsOptional()
  operationDate?: string

  @IsString()
  @IsOptional()
  depositDate?: string

  @IsString()
  @IsOptional()
  receiptUrl?: string

  @IsString()
  @IsOptional()
  titular?: string

  @IsString()
  @IsOptional()
  note?: string
}
