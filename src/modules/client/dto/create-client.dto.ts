import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class ClientLimitsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  movilidadDiario?: number
}

export class CreateClientDto {
  @IsNotEmpty()
  @IsString()
  comercialName: string

  @IsString()
  businessName: string

  @IsString()
  businessId: string //ruc

  @IsString()
  address: string

  @IsString()
  phone: string

  @IsString()
  email: string

  @IsString()
  logo: string

  @IsOptional()
  @ValidateNested()
  @Type(() => ClientLimitsDto)
  limits?: ClientLimitsDto
}
