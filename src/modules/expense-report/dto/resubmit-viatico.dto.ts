import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsMongoId,
  IsArray,
  ValidateNested,
  IsDateString,
} from 'class-validator'
import { Type } from 'class-transformer'
import { CreateAdvanceLineDto } from '../../advance/dto/create-advance.dto'

export class ResubmitViaticoDto {
  @IsNumber()
  @Min(1)
  amount: number

  @IsString()
  @IsNotEmpty()
  place: string

  @IsNumber()
  @Min(-90)
  @Max(90)
  @IsOptional()
  lat?: number

  @IsNumber()
  @Min(-180)
  @Max(180)
  @IsOptional()
  lng?: number

  @IsDateString()
  startDate: string

  @IsDateString()
  endDate: string

  @IsMongoId()
  projectId: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAdvanceLineDto)
  lines: CreateAdvanceLineDto[]

  @IsString()
  @IsOptional()
  observations?: string
}
