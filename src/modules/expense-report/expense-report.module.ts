import { Module } from '@nestjs/common';
import { ExpenseReportService } from './expense-report.service';
import { ExpenseReportController } from './expense-report.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ExpenseReport, ExpenseReportSchema } from './entities/expense-report.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ExpenseReport.name, schema: ExpenseReportSchema }]),
    AuditLogModule,
  ],
  controllers: [ExpenseReportController],
  providers: [ExpenseReportService],
  exports: [ExpenseReportService]
})
export class ExpenseReportModule {}
