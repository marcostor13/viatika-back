import { IsString, IsNumber, IsDateString, Min } from 'class-validator'

export class RegisterDirectReimbursementPaymentDto {
  @IsDateString()
  transferDate: string

  @IsNumber()
  @Min(0)
  amount: number

  @IsString()
  operationNumber: string

  @IsString()
  receiptUrl: string

  @IsString()
  receiptFileName?: string
}
