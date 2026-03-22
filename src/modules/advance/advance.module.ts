import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { AdvanceService } from './advance.service'
import { AdvanceController } from './advance.controller'
import { Advance, AdvanceSchema } from './entities/advance.entity'
import { ExpenseReportModule } from '../expense-report/expense-report.module'
import { AuditLogModule } from '../audit-log/audit-log.module'

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Advance.name, schema: AdvanceSchema }]),
    ExpenseReportModule,
    AuditLogModule,
  ],
  controllers: [AdvanceController],
  providers: [AdvanceService],
  exports: [AdvanceService],
})
export class AdvanceModule {}
