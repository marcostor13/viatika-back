import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { DirectReimbursementService } from './direct-reimbursement.service'
import { DirectReimbursementController } from './direct-reimbursement.controller'
import { DirectReimbursement, DirectReimbursementSchema } from './entities/direct-reimbursement.entity'
import { EmailModule } from '../email/email.module'
import { UserModule } from '../user/user.module'
import { AuditLogModule } from '../audit-log/audit-log.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DirectReimbursement.name, schema: DirectReimbursementSchema },
    ]),
    EmailModule,
    UserModule,
    AuditLogModule,
  ],
  controllers: [DirectReimbursementController],
  providers: [DirectReimbursementService],
  exports: [DirectReimbursementService],
})
export class DirectReimbursementModule {}
