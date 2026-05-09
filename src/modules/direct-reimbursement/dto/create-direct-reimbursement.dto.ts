import { IsString, IsNumber, IsMongoId, MinLength, Min, IsOptional } from 'class-validator'

export class CreateDirectReimbursementDto {
  @IsMongoId()
  collaboratorId: string

  @IsMongoId()
  clientId: string

  @IsString()
  @MinLength(100)
  justification: string

  @IsNumber()
  @Min(0)
  estimatedAmount: number

  @IsString()
  @IsOptional()
  overrunJustification?: string
}
