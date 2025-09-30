import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MongooseModule } from '@nestjs/mongoose'
import { ConfigModule } from '@nestjs/config'
import { UserModule } from './modules/user/user.module'
import { AuthModule } from './modules/auth/auth.module'
import { RoleModule } from './modules/role/role.module'
import { ClientModule } from './modules/client/client.module'
import { ProjectModule } from './modules/project/project.module'
import { CategoryModule } from './modules/category/category.module'
import { InvoiceModule } from './modules/invoice/invoice.module'
import { EmailModule } from './modules/email/email.module'
import { SunatConfigModule } from './modules/sunat-config/sunat-config.module'
import { ExpenseModule } from './modules/expense/expense.module'
import { UploadModule } from './modules/upload/upload.module'
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRoot(process.env.MONGO_URI as string),
    AuthModule,
    UserModule,
    RoleModule,
    ClientModule,
    ProjectModule,
    CategoryModule,
    InvoiceModule,
    EmailModule,
    SunatConfigModule,
    ExpenseModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
