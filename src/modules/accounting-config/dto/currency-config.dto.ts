import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator'

export class CurrencyConfigDto {
  @IsString()
  @IsNotEmpty()
  code: string

  @IsString()
  @IsNotEmpty()
  symbol: string

  @IsString()
  @IsNotEmpty()
  contanetCode: string

  @IsOptional()
  @IsNumber()
  @Min(0)
  decimals?: number

  @IsNumber()
  @Min(0)
  approvalThresholdL1: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  manualRate?: number
}
