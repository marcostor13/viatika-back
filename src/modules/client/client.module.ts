import { Module } from '@nestjs/common'
import { ClientService } from './client.service'
import { ClientController } from './client.controller'
import { MongooseModule } from '@nestjs/mongoose'
import { Client, ClientSchema } from './entities/client.entity'
import { JwtService } from '@nestjs/jwt'

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Client.name, schema: ClientSchema }]),
  ],
  controllers: [ClientController],
  providers: [ClientService, JwtService],
  exports: [ClientService],
})
export class ClientModule {}
