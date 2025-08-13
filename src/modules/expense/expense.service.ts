import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { UpdateExpenseDto } from './dto/update-expense.dto'
import { ConfigService } from '@nestjs/config'
import { Model, Types } from 'mongoose'
import { Expense } from './entities/expense.entity'
import { InjectModel } from '@nestjs/mongoose'
import { EmailService } from '../email/email.service'
import { PROMPT1 } from './constants/prompt1'
import OpenAI from 'openai'
import { ApprovalDto } from './dto/approval.dto'
import { ProjectService } from '../project/project.service'
import { SunatConfigService } from '../sunat-config/sunat-config.service'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom } from 'rxjs'
import { UserService } from '../user/user.service'

@Injectable()
export class ExpenseService {
  private readonly logger = new Logger(ExpenseService.name)
  private readonly openai: OpenAI
  private readonly visionModel = 'gpt-4-turbo'

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(Expense.name)
    private expenseRepository: Model<Expense>,
    private readonly emailService: EmailService,
    private readonly projectService: ProjectService,
    private readonly userService: UserService,
    private readonly sunatConfigService: SunatConfigService,
    private readonly httpService: HttpService
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY')
    if (!apiKey) {
      throw new Error('OpenAI API key is not configured.')
    }
    this.openai = new OpenAI({ apiKey })
  }

  async generateTokenSunat(clientId: string) {
    try {
      const credentials = await this.sunatConfigService.getCredentials(clientId)

      console.log('credentials', credentials)
      const client_id = credentials.clientId
      const client_secret = credentials.clientSecret

      const api = `https://api-seguridad.sunat.gob.pe/v1/clientesextranet/${client_id}/oauth2/token/`
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
      }

      const grant_type = 'client_credentials'
      const scope = 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes'

      const data = {
        grant_type: grant_type,
        scope: scope,
        client_id: client_id,
        client_secret: client_secret,
      }
      const response = await firstValueFrom(
        this.httpService.post(api, data, { headers })
      )

      await this.sunatConfigService.update(credentials._id, {
        isActive: true,
      })

      return response.data
    } catch (error) {
      this.logger.error('Error al generar token de SUNAT', error)
      throw new HttpException(
        'Error al generar token de SUNAT',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  private interpretSunatResponse(sunatData: any): {
    status: string
    details: any
    message: string
  } {
    if (sunatData.success === true && sunatData.data?.estadoCp === '0') {
      return {
        status: 'VALIDO_ACEPTADO',
        details: sunatData.data,
        message: 'El comprobante es válido y fue facturado a esta empresa.',
      }
    } else if (sunatData.success === true && sunatData.data?.estadoCp === '1') {
      return {
        status: 'VALIDO_NO_PERTENECE',
        details: sunatData.data,
        message:
          'El comprobante es válido, pero no fue facturado a esta empresa.',
      }
    } else if (sunatData.cod === '98') {
      return {
        status: 'NO_ENCONTRADO',
        details: sunatData.msg || 'El comprobante no existe en SUNAT.',
        message: 'El comprobante no existe en SUNAT.',
      }
    } else {
      return {
        status: 'ERROR_SUNAT',
        details: sunatData,
        message: 'Error al validar el comprobante.',
      }
    }
  }

  async analyzeImageWithUrl(body: CreateExpenseDto): Promise<Expense> {
    const configSunat = await this.sunatConfigService.findOne(body.clientId)
    const prompt = PROMPT1
    try {
      const response = await this.openai.chat.completions.create({
        model: this.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: body.imageUrl,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      })

      const jsonStringLimpio =
        response.choices[0]?.message?.content ||
        ''
          .replace(/^```json\s*/, '')
          .replace(/\s*```$/, '')
          .trim()
      const jsonObject = JSON.parse(jsonStringLimpio)

      if (jsonObject.serie && jsonObject.correlativo) {
        const existingInvoice = await this.findBySeriAndCorrelativo(
          jsonObject.serie,
          jsonObject.correlativo,
          body.clientId
        )

        if (existingInvoice) {
          throw new HttpException(
            `Ya existe una factura/boleta con el número ${jsonObject.serie}-${jsonObject.correlativo}`,
            HttpStatus.CONFLICT
          )
        }
      }

      let sunatValidationResult = {
        status: 'PENDING',
        details: null,
        message: 'Validación pendiente',
      }
      let expenseStatus = 'pending'
      if (jsonObject.rucEmisor && jsonObject.serie && jsonObject.correlativo) {
        try {
          const sunatApiUrl = `https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/${configSunat.ruc}/validarcomprobante`
          this.logger.log(
            `Usando RUC empresa HARDCODEADO para consulta SUNAT: ${configSunat.ruc}`
          )

          const sunatToken = await this.generateTokenSunat(body.clientId)

          if (sunatToken?.access_token) {
            // Formatear fecha al formato YYYY-MM-DD para SUNAT
            let fechaFormateada = jsonObject.fechaEmision.replace(/-/g, '/')

            this.logger.log(
              `Fecha original: ${jsonObject.fechaEmision}, Fecha formateada para SUNAT: ${fechaFormateada}`
            )

            const params = {
              numRuc: jsonObject.rucEmisor,
              codComp:
                jsonObject.tipoComprobante === 'Factura'
                  ? '01'
                  : jsonObject.tipoComprobante === 'Boleta'
                    ? '03'
                    : '01',
              numeroSerie: jsonObject.serie,
              numero: jsonObject.correlativo,
              fechaEmision: fechaFormateada,
              monto: jsonObject.montoTotal?.toFixed(2),
            }
            const headers = {
              Authorization: `Bearer ${sunatToken.access_token}`,
              'Content-Type': 'application/json',
            }

            try {
              const response = await firstValueFrom(
                this.httpService.post(sunatApiUrl, params, { headers })
              )
              sunatValidationResult = this.interpretSunatResponse(response.data)
              expenseStatus = sunatValidationResult.status
            } catch (error) {
              expenseStatus = 'sunat_error'
              sunatValidationResult = {
                status: 'ERROR_SUNAT',
                details: error.message,
                message: 'Error en la comunicación con SUNAT.',
              }
            }
          } else {
            expenseStatus = 'sunat_error'
          }
        } catch (error) {
          expenseStatus = 'sunat_error'
        }
      }

      const categoryObject = Types.ObjectId.createFromHexString(body.categoryId)
      const projectObject = Types.ObjectId.createFromHexString(body.proyectId)

      if (!body.clientId) {
        throw new HttpException('clientId es requerido', HttpStatus.BAD_REQUEST)
      }

      const expense = await this.expenseRepository.create({
        categoryId: categoryObject,
        proyectId: projectObject,
        clientId: body.clientId,
        total: jsonObject.montoTotal,
        data: JSON.stringify({
          ...jsonObject,
          sunatValidation: sunatValidationResult,
        }),
        file: body.imageUrl,
        status: expenseStatus,
        createdBy: body.userId || 'system',
        fechaEmision: jsonObject.fechaEmision,
      })

      const project = await this.projectService.findOne(
        body.proyectId,
        body.clientId
      )
      try {
        const creatorId = body.userId
        let creatorName = 'Usuario del sistema'

        if (creatorId) {
          try {
            const creator = await this.userService.findOne(creatorId)
            if (creator) {
              creatorName = creator.name
            }
          } catch (error) {
            this.logger.warn(
              'No se pudo obtener información del usuario creador'
            )
          }
        }

        if (body.userId) {
          try {
            const creator = await this.userService.findOne(body.userId)
            if (creator && creator.email) {
              const creatorFullName = creator.name

              await this.emailService.sendInvoiceUploadedExpenseNotification(
                creator.email,
                {
                  providerName: creatorFullName,
                  invoiceNumber: `${jsonObject.serie || ''}-${
                    jsonObject.correlativo || ''
                  }`,
                  date:
                    jsonObject.fechaEmision ||
                    new Date().toISOString().split('T')[0],
                  type: jsonObject.tipoComprobante || 'Factura',
                  status: 'PENDIENTE',
                  montoTotal: jsonObject.montoTotal || 0,
                  moneda: jsonObject.moneda || 'PEN',
                  createdBy: creatorFullName,
                  category: body.categoryId || 'No especificada',
                  projectName: project.name || 'No especificado',
                  razonSocial: jsonObject.razonSocial || 'No especificada',
                  direccionEmisor: jsonObject.direccionEmisor,
                }
              )
            }
          } catch (error) {
            this.logger.warn(
              'No se pudo enviar notificación al creador:',
              error
            )
          }
        }

        try {
          const colaboradores = await this.userService.findAll(
            new Types.ObjectId(body.clientId)
          )

          if (colaboradores && colaboradores.length > 0) {
            this.logger.debug(
              `Encontrados ${colaboradores.length} colaboradores activos para notificar`
            )

            const creatorId = body.userId
            let creatorName = 'Usuario del sistema'

            if (creatorId) {
              try {
                const creator = await this.userService.findOne(creatorId)
                if (creator) {
                  creatorName = creator.name
                }
              } catch (error) {
                this.logger.warn(
                  'No se pudo obtener información del usuario creador'
                )
              }
            }

            for (const colaborador of colaboradores) {
              if (colaborador.email) {
                try {
                  await this.emailService.sendInvoiceUploadedExpenseNotification(
                    colaborador.email,
                    {
                      providerName: creatorName,
                      invoiceNumber: `${jsonObject.serie || ''}-${
                        jsonObject.correlativo || ''
                      }`,
                      date:
                        jsonObject.fechaEmision ||
                        new Date().toISOString().split('T')[0],
                      type: jsonObject.tipoComprobante || 'Factura',
                      status: 'PENDIENTE',
                      montoTotal: jsonObject.montoTotal || 0,
                      moneda: jsonObject.moneda || 'PEN',
                      createdBy: creatorName,
                      category: body.categoryId || 'No especificada',
                      projectName: project.name || 'No especificado',
                      razonSocial: jsonObject.razonSocial || 'No especificada',
                      direccionEmisor: jsonObject.direccionEmisor,
                    }
                  )
                  this.logger.debug(
                    `Notificación enviada al colaborador: ${colaborador.email}`
                  )
                } catch (error) {
                  this.logger.warn(
                    `Error al enviar notificación al colaborador ${colaborador.email}:`,
                    error
                  )
                }
              }
            }
          } else {
            this.logger.debug(
              'No se encontraron usuarios con rol COLABORADOR activos'
            )
          }
        } catch (error) {
          this.logger.error(
            'Error al enviar notificaciones a colaboradores:',
            error
          )
        }
      } catch (error) {
        this.logger.error('Error al enviar notificaciones de correo:', error)
      }

      return expense
    } catch (error) {
      if (error instanceof HttpException) {
        throw error
      }

      this.logger.error('OpenAI API Error Response:', error)
      throw new HttpException(
        'Error al analizar la imagen desde la URL con OpenAI.',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  async create(createExpenseDto: CreateExpenseDto): Promise<Expense> {
    let fechaEmisionDate: Date | undefined = undefined
    if ('fechaEmision' in createExpenseDto && createExpenseDto.fechaEmision) {
      fechaEmisionDate = new Date(createExpenseDto.fechaEmision as any)
    } else if ((createExpenseDto as any).data) {
      let dataObj: any = (createExpenseDto as any).data
      if (typeof dataObj === 'string') {
        try {
          dataObj = JSON.parse(dataObj)
        } catch {}
      }
      if (dataObj && dataObj.fechaEmision) {
        fechaEmisionDate = parseFechaEmision(dataObj.fechaEmision)
      }
    }
    const createdExpense = new this.expenseRepository({
      ...createExpenseDto,
      clientId: new Types.ObjectId(createExpenseDto.clientId),
      fechaEmision: fechaEmisionDate,
    })
    return createdExpense.save()
  }

  async findAll(clientId: string, filters: any = {}): Promise<Expense[]> {
    const query: any = { clientId }

    const isValidObjectId = (id: string): boolean => {
      return /^[0-9a-fA-F]{24}$/.test(id)
    }

    if (filters.createdBy) {
      if (isValidObjectId(filters.createdBy)) {
        query.createdBy = filters.createdBy
      }
    }

    if (filters.projectId) {
      if (isValidObjectId(filters.projectId)) {
        query.$or = [
          { proyectId: filters.projectId },
          { proyectId: Types.ObjectId.createFromHexString(filters.projectId) },
        ]
      }
    }

    if (filters.proyectId) {
      if (isValidObjectId(filters.proyectId)) {
        query.$or = [
          { proyectId: filters.proyectId },
          { proyectId: Types.ObjectId.createFromHexString(filters.proyectId) },
        ]
      }
    }

    if (filters.categoryId) {
      if (isValidObjectId(filters.categoryId)) {
        if (query.$or) {
          const projectConditions = query.$or
          delete query.$or
          query.$and = [
            { $or: projectConditions },
            {
              $or: [
                { categoryId: filters.categoryId },
                {
                  categoryId: Types.ObjectId.createFromHexString(
                    filters.categoryId
                  ),
                },
              ],
            },
          ]
        } else {
          query.$or = [
            { categoryId: filters.categoryId },
            {
              categoryId: Types.ObjectId.createFromHexString(
                filters.categoryId
              ),
            },
          ]
        }
      }
    }

    if (filters.status) query.status = filters.status

    if (filters.dateFrom || filters.dateTo) {
      if (filters.dateFrom) {
        const dateFrom = new Date(filters.dateFrom)
        dateFrom.setUTCHours(0, 0, 0, 0)
        query.createdAt = { $gte: dateFrom }
      }
      if (filters.dateTo) {
        const dateTo = new Date(filters.dateTo)
        dateTo.setUTCHours(23, 59, 59, 999)
        if (query.createdAt) {
          query.createdAt.$lte = dateTo
        } else {
          query.createdAt = { $lte: dateTo }
        }
      }
    }
    if (filters.amountMin || filters.amountMax) {
      query.total = {}
      if (filters.amountMin) query.total.$gte = Number(filters.amountMin)
      if (filters.amountMax) query.total.$lte = Number(filters.amountMax)
    }

    if (filters.serie && filters.correlativo) {
      const expense = await this.findBySeriAndCorrelativo(
        filters.serie,
        filters.correlativo,
        clientId
      )
      return expense ? [expense] : []
    }

    const sortBy = filters.sortBy || 'fechaEmision'
    const sortOrder = filters.sortOrder || 'desc'

    let sortField = sortBy
    if (sortBy === 'fechaEmision') {
      sortField = 'fechaEmision'
    } else if (sortBy === 'createdAt') {
      sortField = 'createdAt'
    }

    const sortOptions: any = {}
    sortOptions[sortField] = sortOrder === 'desc' ? -1 : 1

    if (sortBy === 'fechaEmision') {
      sortOptions['createdAt'] = sortOrder === 'desc' ? -1 : 1
    }

    const result = await this.expenseRepository
      .find(query)
      .populate('proyectId')
      .populate('categoryId')
      .sort(sortOptions)
      .exec()

    return result
  }

  async findOne(id: string): Promise<Expense | null> {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`ID de expense inválido: ${id}`)
    }

    const expenseIdObject = Types.ObjectId.createFromHexString(id)

    return this.expenseRepository
      .findOne({ _id: expenseIdObject })
      .populate('proyectId')
      .populate('categoryId')
      .exec()
  }

  async getSunatValidationInfo(id: string): Promise<any> {
    const expense = await this.findOne(id)

    if (!expense) {
      throw new NotFoundException(`Expense with ID ${id} not found`)
    }

    try {
      const data = JSON.parse(expense.data)
      const sunatValidation = data.sunatValidation

      return {
        expenseId: String((expense as any)._id),
        status: expense.status,
        sunatValidation: sunatValidation || null,
        hasValidation: !!sunatValidation,
        message:
          sunatValidation?.message ||
          'No hay información de validación SUNAT disponible',
        extractedData: {
          rucEmisor: data.rucEmisor,
          serie: data.serie,
          correlativo: data.correlativo,
          fechaEmision: data.fechaEmision,
          montoTotal: data.montoTotal,
        },
      }
    } catch (error) {
      this.logger.error(`Error parsing expense data: ${error.message}`)
      return {
        expenseId: String((expense as any)._id),
        status: expense.status,
        sunatValidation: null,
        hasValidation: false,
        message: 'Error al procesar la información de validación SUNAT',
      }
    }
  }

  async update(
    id: string,
    updateExpenseDto: UpdateExpenseDto
  ): Promise<Expense | null> {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`ID de expense inválido: ${id}`)
    }

    const expenseIdObject = Types.ObjectId.createFromHexString(id)

    if (updateExpenseDto.categoryId) {
      const expense = await this.findOne(id)
      if (!expense) {
        throw new NotFoundException(`Gasto con ID ${id} no encontrado`)
      }
    }

    return this.expenseRepository
      .findOneAndUpdate({ _id: expenseIdObject }, updateExpenseDto, {
        new: true,
      })
      .populate('clientId')
      .populate('categoryId')
      .exec()
  }

  async approveInvoice(id: string, approvalDto: ApprovalDto) {
    const expense = await this.findOne(id)
    if (!expense) {
      throw new NotFoundException(`Factura con ID ${id} no encontrada`)
    }

    if (expense.status === 'approved') {
      throw new HttpException(
        'La factura ya ha sido aprobada',
        HttpStatus.BAD_REQUEST
      )
    }

    if (expense.status === 'rejected') {
      throw new HttpException(
        'La factura ya ha sido rechazada',
        HttpStatus.BAD_REQUEST
      )
    }

    let validUserId = null
    let userEmail = null
    let userName = null
    let userLastName = null

    const updatedExpense = await this.expenseRepository
      .findByIdAndUpdate(
        id,
        {
          status: 'approved',
          statusDate: new Date(),
          approvedBy: validUserId,
        },
        { new: true }
      )
      .exec()

    setImmediate(() => {
      this.sendApprovalEmails(expense, validUserId, userName).catch(error => {
        this.logger.error('Error al enviar correos de aprobación:', error)
      })
    })

    this.logger.log(`Factura ${id} aprobada exitosamente`)
    return updatedExpense
  }

  private async sendApprovalEmails(
    expense: any,
    validUserId: string | null,
    userName?: string | null,
    userLastName?: string | null
  ) {
    try {
      let approverName = 'Administrador del Sistema'

      if (userName && userLastName) {
        approverName = `${userName} ${userLastName}`
        this.logger.debug(
          `Usando información de aprobador encontrada previamente: ${approverName}`
        )
      } else if (validUserId) {
        try {
          const approver = await this.userService.findOne(validUserId)
          if (approver) {
            approverName = approver.name

            this.logger.debug(
              `Información de aprobador obtenida de la BD: ${approverName}`
            )
          }
        } catch (error) {
          this.logger.warn('No se pudo obtener información del aprobador')
        }
      } else {
        this.logger.warn(
          'Usando valor predeterminado para el aprobador: Administrador del Sistema'
        )
      }

      const invoiceData = expense.data ? JSON.parse(expense.data) : {}

      if (expense.createdBy) {
        try {
          if (!/^[0-9a-fA-F]{24}$/.test(expense.createdBy)) {
            this.logger.warn(`ID del creador inválido: ${expense.createdBy}`)
            return
          }

          const creator = await this.userService.findOne(expense.createdBy)

          if (creator && creator.email) {
            const creatorFullName = creator.name

            this.logger.debug(
              `Enviando notificación de aprobación a ${creator.email}, rol: ${creator.role}`
            )
          } else {
            this.logger.warn(
              'No se encontró email para el creador de la factura'
            )
          }
        } catch (error) {
          this.logger.warn(
            'No se pudo encontrar al creador de la factura:',
            error
          )
        }
      } else {
        this.logger.warn(
          'La factura no tiene un creador asignado (createdBy es null)'
        )
      }

      try {
        const colaboradores = await this.userService.findAll(
          new Types.ObjectId(expense.clientId)
        )

        if (colaboradores && colaboradores.length > 0) {
          this.logger.debug(
            `Notificando a ${colaboradores.length} colaboradores sobre factura aprobada`
          )

          const creadorId = expense.createdBy || ''

          for (const colaborador of colaboradores) {
            if (colaborador.email && colaborador._id.toString() !== creadorId) {
              try {
                await this.emailService.sendInvoiceApprovedToColaborador(
                  colaborador.email,
                  {
                    providerName: colaborador.name,
                    invoiceNumber: `${invoiceData.serie || ''}-${
                      invoiceData.correlativo || ''
                    }`,
                    date:
                      invoiceData.fechaEmision ||
                      new Date().toISOString().split('T')[0],
                    type: invoiceData.tipoComprobante || 'Factura',
                    approvedBy: approverName,
                  }
                )
                this.logger.debug(
                  `Notificación de aprobación enviada a colaborador ${colaborador.email}`
                )
              } catch (error) {
                this.logger.warn(
                  `Error al enviar notificación de aprobación al colaborador ${colaborador.email}:`,
                  error
                )
              }
            }
          }
        } else {
          this.logger.debug(
            'No hay colaboradores activos para notificar sobre la factura aprobada'
          )
        }
      } catch (error) {
        this.logger.error(
          'Error al notificar a colaboradores sobre factura aprobada:',
          error
        )
      }
    } catch (error) {
      this.logger.error('Error al enviar notificación de aprobación:', error)
    }
  }

  async rejectInvoice(id: string, approvalDto: ApprovalDto) {
    const expense = await this.findOne(id)
    if (!expense) {
      throw new NotFoundException(`Factura con ID ${id} no encontrada`)
    }

    if (expense.status === 'approved') {
      throw new HttpException(
        'La factura ya ha sido aprobada',
        HttpStatus.BAD_REQUEST
      )
    }

    if (expense.status === 'rejected') {
      throw new HttpException(
        'La factura ya ha sido rechazada',
        HttpStatus.BAD_REQUEST
      )
    }

    if (!approvalDto.reason) {
      throw new HttpException(
        'Se requiere un motivo para rechazar la factura',
        HttpStatus.BAD_REQUEST
      )
    }

    let validUserId = null
    let userName = null
    let userLastName = null

    const updatedExpense = await this.expenseRepository
      .findByIdAndUpdate(
        id,
        {
          status: 'rejected',
          statusDate: new Date(),
          rejectedBy: validUserId,
          rejectionReason: approvalDto.reason,
        },
        { new: true }
      )
      .exec()

    setImmediate(() => {
      this.sendRejectionEmails(
        expense,
        validUserId,
        userName,
        userLastName,
        approvalDto.reason
      ).catch(error => {
        this.logger.error('Error al enviar correos de rechazo:', error)
      })
    })

    this.logger.log(`Factura ${id} rechazada exitosamente`)
    return updatedExpense
  }

  private async sendRejectionEmails(
    expense: any,
    validUserId: string | null,
    userName?: string | null,
    userLastName?: string | null,
    rejectionReason?: string
  ) {
    try {
      let rejectorName = 'Administrador del Sistema'

      if (userName && userLastName) {
        rejectorName = `${userName} ${userLastName}`
        this.logger.debug(
          `Usando información de rechazador encontrada previamente: ${rejectorName}`
        )
      } else if (validUserId) {
        try {
          const rejector = await this.userService.findOne(validUserId)
          if (rejector) {
            rejectorName = rejector.name

            this.logger.debug(
              `Información de rechazador obtenida de la BD: ${rejectorName}`
            )
          }
        } catch (error) {
          this.logger.warn(
            'No se pudo obtener información del administrador que rechazó'
          )
        }
      } else {
        this.logger.warn(
          'Usando valor predeterminado para el rechazador: Administrador del Sistema'
        )
      }

      const invoiceData = expense.data ? JSON.parse(expense.data) : {}

      if (expense.createdBy) {
        try {
          if (!/^[0-9a-fA-F]{24}$/.test(expense.createdBy)) {
            this.logger.warn(`ID del creador inválido: ${expense.createdBy}`)
            return
          }

          const creator = await this.userService.findOne(expense.createdBy)

          if (creator && creator.email) {
            const creatorFullName = creator.name

            this.logger.debug(
              `Enviando notificación de rechazo a ${creator.email}, rol: ${creator.role}`
            )
          } else {
            this.logger.warn(
              'No se encontró email para el creador de la factura'
            )
          }
        } catch (error) {
          this.logger.warn(
            'No se pudo encontrar al creador de la factura:',
            error
          )
        }
      } else {
        this.logger.warn(
          'La factura no tiene un creador asignado (createdBy es null)'
        )
      }
    } catch (error) {
      this.logger.error('Error al enviar notificación de rechazo:', error)
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`ID de expense inválido: ${id}`)
    }

    const expenseIdObject = Types.ObjectId.createFromHexString(id)

    await this.expenseRepository
      .findOneAndDelete({ _id: expenseIdObject })
      .exec()
  }

  async findBySeriAndCorrelativo(
    serie: string,
    correlativo: string,
    clientId?: string
  ): Promise<Expense | null> {
    try {
      this.logger.debug(
        `Buscando duplicados - Serie: ${serie}, Correlativo: ${correlativo}, clientId: ${clientId}`
      )

      const query: any = {}

      if (clientId) {
        query.clientId = clientId
      }

      this.logger.debug(`Query de búsqueda: ${JSON.stringify(query)}`)

      const expenses = await this.expenseRepository.find(query).exec()

      this.logger.debug(`Encontradas ${expenses.length} facturas para revisar`)

      for (const expense of expenses) {
        if (expense.data) {
          try {
            let dataObj: any = expense.data
            if (typeof dataObj === 'string') {
              dataObj = JSON.parse(dataObj)
            }

            this.logger.debug(
              `Revisando factura ${expense._id}: Serie: ${dataObj?.serie}, Correlativo: ${dataObj?.correlativo}`
            )

            if (
              dataObj &&
              dataObj.serie === serie &&
              dataObj.correlativo === correlativo
            ) {
              this.logger.debug(`DUPLICADO ENCONTRADO: Factura ${expense._id}`)
              return expense
            }
          } catch (error) {
            this.logger.warn(
              `Error parseando data de factura ${expense._id}:`,
              error
            )
            continue
          }
        }
      }

      this.logger.debug(`No se encontraron duplicados`)
      return null
    } catch (error) {
      this.logger.error(
        'Error al buscar factura por serie y correlativo:',
        error
      )
      throw new HttpException(
        'Error al validar duplicados',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}

function parseFechaEmision(fecha: string): Date | undefined {
  const parts = fecha.split(/[\/\-]/)
  if (parts.length === 3) {
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
  }
  return undefined
}
