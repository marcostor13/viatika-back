import { IsString, IsNumber, IsOptional, IsMongoId, IsIn } from 'class-validator';

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
}
