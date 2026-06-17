import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { BolsaService } from './bolsa.service'
import { BolsaController } from './bolsa.controller'
import { WalletEntry, WalletEntrySchema } from './entities/wallet-entry.entity'
import { AuditLogModule } from '../audit-log/audit-log.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WalletEntry.name, schema: WalletEntrySchema },
    ]),
    AuditLogModule,
  ],
  controllers: [BolsaController],
  providers: [BolsaService],
  // Se exporta para que expense-report / advance / petty-cash puedan abonar y
  // consumir saldos de la Bolsa (BOLSA-2/3/4/5/6).
  exports: [BolsaService, MongooseModule],
})
export class BolsaModule {}
