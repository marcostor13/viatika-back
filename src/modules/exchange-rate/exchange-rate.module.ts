import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { ExchangeRateService } from './exchange-rate.service'
import { CurrencyService } from './currency.service'
import {
  ExchangeRate,
  ExchangeRateSchema,
} from './entities/exchange-rate.entity'
import { AccountingConfigModule } from '../accounting-config/accounting-config.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExchangeRate.name, schema: ExchangeRateSchema },
    ]),
    AccountingConfigModule,
  ],
  providers: [ExchangeRateService, CurrencyService],
  exports: [ExchangeRateService, CurrencyService],
})
export class ExchangeRateModule {}
