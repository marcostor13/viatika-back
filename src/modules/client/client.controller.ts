import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards } from '@nestjs/common';
import { ClientService } from './client.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES } from '../auth/enums/roles.enum';
import { Roles } from '../auth/decorators/roles.decorador';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';


@Controller('client')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClientController {
  constructor(private readonly clientService: ClientService) { }

  @Post()
  @Roles(ROLES.SUPER_ADMIN)
  create(@Body() createClientDto: CreateClientDto) {
    return this.clientService.create(createClientDto);
  }

  @Get()
  @Roles(ROLES.SUPER_ADMIN)
  findAll() {
    return this.clientService.findAll();
  }

  @Get(':id')
  @Roles(ROLES.SUPER_ADMIN)
  findOne(@Param('id') id: string) {
    return this.clientService.findOne(id);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() updateClientDto: UpdateClientDto) {
    return this.clientService.update(id, updateClientDto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.clientService.remove(id);
  }
}
