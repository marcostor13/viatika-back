import { PartialType } from '@nestjs/mapped-types';
import { CreateExpenseReportDto } from './create-expense-report.dto';
import { IsOptional, IsMongoId, IsArray, IsIn, IsString } from 'class-validator';
import { ExpenseReportStatus } from '../entities/expense-report.entity';

export class UpdateExpenseReportDto extends PartialType(CreateExpenseReportDto) {
  @IsOptional()
  @IsIn(['open', 'submitted', 'approved', 'rejected', 'closed'])
  status?: ExpenseReportStatus;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  expenseIds?: string[];
}
