import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator'

export class CreateAdvanceDto {
  @IsNumber()
  @Min(1)
  amount: number

  @IsString()
  @IsNotEmpty()
  description: string

  @IsString()
  @IsOptional()
  expenseReportId?: string

  // Seteados desde el JWT
  userId?: string
  clientId?: string
}
