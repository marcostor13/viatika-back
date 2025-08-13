import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Request,
  UseGuards,
  Logger,
  Query,
} from '@nestjs/common'
import { ExpenseService } from './expense.service'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { UpdateExpenseDto } from './dto/update-expense.dto'
import { ApprovalDto } from './dto/approval.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { Types } from 'mongoose'

@Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
@Controller('expense')
export class ExpenseController {
  private readonly logger = new Logger(ExpenseController.name)

  constructor(private readonly expenseService: ExpenseService) {}

  @Post('analyze-image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  analyzeImage(@Body() body: CreateExpenseDto, @Request() req) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) {
      throw new Error('No se pudo obtener la empresa del usuario ni del body')
    }

    body.clientId = clientId
    body.userId = req.user?.sub || req.user?._id || body.userId

    return this.expenseService.analyzeImageWithUrl(body)
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  create(@Body() createExpenseDto: CreateExpenseDto) {
    return this.expenseService.create(createExpenseDto)
  }

  @Get(':clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findAll(
    @Param('clientId') clientId: string,
    @Request() req,
    @Query() query: any,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    if (sortBy) query.sortBy = sortBy
    if (sortOrder) query.sortOrder = sortOrder

    return this.expenseService.findAll(clientId, query)
  }

  @Get('invoice/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string) {
    return this.expenseService.findOne(id)
  }

  @Get('test-sunat-credentials/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async testSunatCredentials(@Param('clientId') clientId: string) {
    try {
      const token = await this.expenseService.generateTokenSunat(clientId)
      return {
        success: true,
        message: 'Credenciales SUNAT funcionando correctamente',
        token: {
          access_token: token.access_token ? 'PRESENTE' : 'AUSENTE',
          // token_type: token.token_type,
          // expires_in: token.expires_in,
        },
      }
    } catch (error) {
      return {
        success: false,
        message: 'Error en credenciales SUNAT',
        error: error.message,
        details: error.response?.data || 'Sin detalles adicionales',
      }
    }
  }

  @Get('invoice/:id/sunat-validation')
  @UseGuards(JwtAuthGuard, RolesGuard)
  getSunatValidation(@Param('id') id: string) {
    return this.expenseService.getSunatValidationInfo(id)
  }

  @Patch('invoice/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  update(@Param('id') id: string, @Body() updateExpenseDto: UpdateExpenseDto) {
    return this.expenseService.update(id, updateExpenseDto)
  }

  @Patch('invoice/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  approveInvoice(
    @Param('id') id: string,
    @Body() approvalDto: ApprovalDto,
    @Request() req
  ) {
    this.logger.debug(
      `Contenido de req.user: ${JSON.stringify(req.user || 'No disponible')}`
    )

    if (req.user && req.user._id) {
      this.logger.debug(`Usando ID de usuario del JWT: ${req.user._id}`)
      approvalDto.userId = req.user._id
    } else if (req.user && req.user.sub) {
      this.logger.debug(
        `Usando ID de usuario del campo sub del JWT: ${req.user.sub}`
      )
      approvalDto.userId = req.user.sub
    } else {
      this.logger.warn(
        `No se encontró ID de usuario en el JWT, se usará el proporcionado: ${approvalDto.userId || 'ninguno'}`
      )
    }

    return this.expenseService.approveInvoice(id, approvalDto)
  }

  @Patch('invoice/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  rejectInvoice(
    @Param('id') id: string,
    @Body() approvalDto: ApprovalDto,
    @Request() req
  ) {
    this.logger.debug(
      `Contenido de req.user: ${JSON.stringify(req.user || 'No disponible')}`
    )

    if (req.user && req.user._id) {
      this.logger.debug(`Usando ID de usuario del JWT: ${req.user._id}`)
      approvalDto.userId = req.user._id
    } else if (req.user && req.user.sub) {
      this.logger.debug(
        `Usando ID de usuario del campo sub del JWT: ${req.user.sub}`
      )
      approvalDto.userId = req.user.sub
    } else {
      this.logger.warn(
        `No se encontró ID de usuario del JWT, se usará el proporcionado: ${approvalDto.userId || 'ninguno'}`
      )
    }

    return this.expenseService.rejectInvoice(id, approvalDto)
  }

  @Delete('invoice/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  remove(@Param('id') id: string) {
    return this.expenseService.remove(id)
  }
}
