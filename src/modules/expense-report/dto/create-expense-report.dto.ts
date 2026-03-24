import { IsString, IsNumber, IsOptional, IsMongoId, IsIn, IsArray, ValidateNested, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

class BudgetItemDto {
  @IsString()
  description: string;

  @IsNumber()
  amount: number;

  @IsNumber()
  @IsOptional()
  peopleCount?: number;

  @IsNumber()
  @IsOptional()
  fuelAmount?: number;

  @IsNumber()
  @IsOptional()
  daysCount?: number;

  @IsNumber()
  total: number;
}

export class CreateExpenseReportDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsOptional()
  budget?: number;

  @IsMongoId()
  userId: string; // The collaborator assigned

  @IsMongoId()
  clientId: string; // The company

  @IsMongoId()
  @IsOptional()
  createdBy?: string; // The admin creating it

  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  accountNumber?: string;

  @IsString()
  @IsOptional()
  idDocument?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  peopleNames?: string[];

  @IsString()
  @IsOptional()
  location?: string;

  @IsDateString()
  @IsOptional()
  startDate?: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => BudgetItemDto)
  items?: BudgetItemDto[];
}
