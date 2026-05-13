import { Injectable, Logger } from '@nestjs/common'
import { MailerService } from '@nestjs-modules/mailer'

const DEFAULT_PROD_APP_URL = 'https://app.viatika.tecdidata.com'
const LEGACY_PROD_APP_HOST = 'app.viatica.tecdidata.com'
const CURRENT_PROD_APP_HOST = 'app.viatika.tecdidata.com'

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)

  constructor(private readonly mailerService: MailerService) {}

  /**
   * URL pública del front (local vs prod vía env).
   * Preferir `APP_PUBLIC_URL` o `FRONTEND_URL` en `.env`.
   */
  private normalizePublicAppBaseUrl(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, '')
    if (!trimmed) return trimmed

    try {
      const parsed = new URL(trimmed)
      if (parsed.hostname === LEGACY_PROD_APP_HOST) {
        parsed.hostname = CURRENT_PROD_APP_HOST
      }
      return parsed.toString().replace(/\/+$/, '')
    } catch {
      return trimmed
    }
  }

  getPublicAppBaseUrl(): string {
    const raw = (
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      ''
    ).trim()
    if (raw) {
      return this.normalizePublicAppBaseUrl(raw)
    }
    return process.env.NODE_ENV === 'production'
      ? DEFAULT_PROD_APP_URL
      : 'http://localhost:4200'
  }

  /** Ruta absoluta en el front, p. ej. `/tesoreria` → `https://…/tesoreria` */
  buildAppUrl(path?: string): string {
    const base = this.getPublicAppBaseUrl()
    if (!path?.trim()) return base
    const p = path.trim()
    if (/^https?:\/\//i.test(p)) {
      return p.replace(/\/+$/, '')
    }
    const suffix = p.startsWith('/') ? p : `/${p}`
    return `${base}${suffix}`
  }

  getLogoUrl(): string {
    const logo = process.env.APP_LOGO_URL?.trim()
    if (logo) return logo
    return this.buildAppUrl('/logo.svg')
  }

  private normalizeCurrencySymbol(currency?: string | null): string {
    const value = currency?.trim()
    if (!value) return ''

    switch (value.toUpperCase()) {
      case 'PEN':
      case 'S/':
      case 'SOL':
      case 'SOLES':
        return 'S/'
      case 'USD':
      case '$':
      case 'US$':
      case 'DOLAR':
      case 'DOLARES':
      case 'DÓLAR':
      case 'DÓLARES':
        return '$'
      default:
        return value
    }
  }

  private formatCurrencyAmount(
    amount?: number | string | null,
    currency?: string | null
  ): string {
    if (amount === undefined || amount === null || amount === '') return ''

    const numericAmount =
      typeof amount === 'number' ? amount : Number.parseFloat(String(amount))
    const amountText = Number.isFinite(numericAmount)
      ? Number.isInteger(numericAmount)
        ? String(numericAmount)
        : numericAmount.toFixed(2)
      : String(amount).trim()

    const symbol = this.normalizeCurrencySymbol(currency)
    return symbol ? `${symbol} ${amountText}` : amountText
  }

  /** `platformUrl` en plantillas: absoluta del caller o base + ruta relativa. */
  resolvePlatformHref(url?: string | null): string {
    const s = url?.trim()
    if (!s) return this.getPublicAppBaseUrl()
    if (/^https?:\/\//i.test(s)) {
      return s.replace(/\/+$/, '')
    }
    return this.buildAppUrl(s)
  }

  getCode() {
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    return code
  }

  async sendCodeConfirmation(email: string) {
    try {
      this.logger.debug(`Enviando código de confirmación a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Confirma tu correo en Nuestra App',
        template: './confirmation', // se añade automáticamente la extensión (.hbs)
        context: {
          logoUrl: this.getLogoUrl(),
          verificationCode: this.getCode(),
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(
        `Código de confirmación enviado exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar código de confirmación a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendInvoiceNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura a ${email}`, data)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Nueva Factura Subida',
        template: './invoice-notification',
        context: {
          logoUrl: this.getLogoUrl(),
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendPaymentScheduledNotification(
    email: string,
    invoiceNumber: string,
    paymentDate: string
  ) {
    await this.mailerService.sendMail({
      to: email,
      subject: 'Pago Programado',
      template: './payment-scheduled',
      context: {
        logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
        invoiceNumber,
        paymentDate,
        year: new Date().getFullYear(),
      },
    })
  }

  async sendAccountingDecisionNotification(
    email: string,
    invoiceNumber: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ) {
    await this.mailerService.sendMail({
      to: email,
      subject: `Factura ${decision === 'approved' ? 'Aprobada' : 'Rechazada'}`,
      template: './accounting-decision',
      context: {
        logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
        invoiceNumber,
        decisionText: decision === 'approved' ? 'Aprobada' : 'Rechazada',
        reason,
        year: new Date().getFullYear(),
      },
    })
  }

  async sendActaNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de acta a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Acta de Aceptación Subida',
        template: './acta-notification',
        context: {
          logoUrl: this.getLogoUrl(),
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(`Notificación de acta enviada exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de acta a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendInvoiceUploadedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: Date
      type: string
      createdBy?: string
      razonSocial?: string
      montoTotal?: number
      moneda?: string
      status?: string
      showAdditionalInfo?: boolean
      category?: string
      projectName?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura subida a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Nueva factura subida por ' + (data.createdBy || data.providerName),
        template: './invoice-notification',
        context: {
          logoUrl: this.getLogoUrl(),
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date:
            data.date instanceof Date
              ? data.date.toLocaleDateString()
              : data.date,
          type: data.type,
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          razonSocial: data.razonSocial,
          montoTotalFormatted: this.formatCurrencyAmount(
            data.montoTotal,
            data.moneda
          ),
          status: data.status,
          showAdditionalInfo: data.showAdditionalInfo,
          category: data.category,
          projectName: data.projectName,
          direccionEmisor: data.direccionEmisor,
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendActaUploadedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: Date
      type: string
      createdBy?: string
      razonSocial?: string
      montoTotal?: number
      moneda?: string
      status?: string
      showAdditionalInfo?: boolean
      category?: string
      projectName?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de acta subida a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Acta de aprobación subida por ' +
          (data.createdBy || data.providerName),
        template: './acta-notification',
        context: {
          logoUrl: this.getLogoUrl(),
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date:
            data.date instanceof Date
              ? data.date.toLocaleDateString()
              : data.date,
          type: data.type,
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          razonSocial: data.razonSocial,
          montoTotalFormatted: this.formatCurrencyAmount(
            data.montoTotal,
            data.moneda
          ),
          status: data.status,
          showAdditionalInfo: data.showAdditionalInfo,
          category: data.category,
          projectName: data.projectName,
          direccionEmisor: data.direccionEmisor,
        },
      })
      this.logger.debug(`Notificación de acta enviada exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceUploadedExpenseNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: string
      montoTotal: number
      moneda: string
      createdBy?: string
      category?: string
      projectName?: string
      razonSocial?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura de gastos a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Nueva factura de gastos subida por ' +
          (data.createdBy || data.providerName),
        template: './invoice-notification',
        context: {
          logoUrl: this.getLogoUrl(),
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          status: data.status,
          montoTotalFormatted: this.formatCurrencyAmount(
            data.montoTotal,
            data.moneda
          ),
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          category: data.category || 'No especificada',
          projectName: data.projectName || 'No especificado',
          razonSocial: data.razonSocial || 'No especificada',
          direccionEmisor: data.direccionEmisor,
          showAdditionalInfo: true,
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceApprovedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      approvedBy?: string
    }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Factura Aprobada',
        template: 'invoice-approved',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          approvedBy: data.approvedBy || 'Administrador del sistema',
        },
      })
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura aprobada: ${error.message}`
      )
      throw error
    }
  }

  async sendInvoiceRejectedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      rejectionReason: string
      rejectedBy?: string
    }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Factura Rechazada',
        template: 'invoice-rejected',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          rejectionReason: data.rejectionReason,
          rejectedBy: data.rejectedBy || 'Administrador del sistema',
        },
      })
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura rechazada: ${error.message}`
      )
      throw error
    }
  }

  async sendInvoiceDecisionNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: 'APPROVED' | 'REJECTED'
      rejectionReason?: string
    }
  ) {
    try {
      this.logger.debug(
        `[DEBUG] Enviando notificación de decisión de factura a ${email}`,
        data
      )

      await this.mailerService.sendMail({
        to: email,
        subject: `Factura ${data.status === 'APPROVED' ? 'Aprobada para Pago' : 'Rechazada para Pago'}`,
        template: 'invoice-decision',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          status: data.status,
          rejectionReason: data.rejectionReason,
          // Agregar helper para comparación de strings en el template
          eq: (a: string, b: string) => a === b,
        },
      })

      this.logger.debug(
        `[DEBUG] Notificación de decisión enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `[DEBUG] Error al enviar notificación de decisión a ${email}: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async sendProviderWelcomeEmail(
    email: string,
    data: {
      firstName: string
      lastName: string
      password: string
      loginUrl: string
    }
  ) {
    try {
      this.logger.debug(`Enviando correo de bienvenida a proveedor: ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Bienvenido a Nuestra Plataforma de Proveedores',
        template: './provider-welcome',
        context: {
          logoUrl: this.getLogoUrl(),
          firstName: data.firstName,
          lastName: data.lastName,
          email: email,
          password: data.password,
          loginUrl: data.loginUrl,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(`Correo de bienvenida enviado exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar correo de bienvenida a ${email}:`,
        error
      )
      throw error
    }
  }

  // Métodos específicos para la notificación a roles ADMIN2 y COLABORADOR
  async sendInvoiceCreatedToAdmin2(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: string
      montoTotal: number
      moneda: string
      createdBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura creada a admin2 ${email}`
      )
      await this.sendInvoiceUploadedExpenseNotification(email, data)
      this.logger.debug(
        `Notificación de factura creada enviada exitosamente a admin2 ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación a admin2 ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceApprovedToColaborador(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      approvedBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura aprobada a colaborador ${email}`
      )
      await this.sendInvoiceApprovedNotification(email, data)
      this.logger.debug(
        `Notificación de factura aprobada enviada exitosamente a colaborador ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de aprobación a colaborador ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceRejectedToColaborador(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      rejectionReason: string
      rejectedBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura rechazada a colaborador ${email}`
      )
      await this.sendInvoiceRejectedNotification(email, data)
      this.logger.debug(
        `Notificación de factura rechazada enviada exitosamente a colaborador ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de rechazo a colaborador ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendRendicionFullyApprovedEmail(
    email: string,
    data: {
      userName: string
      title: string
      budget: number
      platformUrl?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando correo de rendición aprobada a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: '¡Rendición de Gastos Aprobada!',
        template: './rendicion-approved',
        context: {
          logoUrl: this.getLogoUrl(),
          userName: data.userName,
          title: data.title,
          budget: `S/ ${Number(data.budget).toFixed(2)}`,
          platformUrl: this.resolvePlatformHref(data.platformUrl),
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(`Correo de rendición aprobada enviado a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar correo de rendición aprobada a ${email}:`,
        error
      )
    }
  }

  async sendRendicionSubmitted(
    email: string,
    data: {
      recipientName: string
      collaboratorName: string
      reportTitle: string
      budgetFormatted: string
      expenseCount: number
      platformUrl?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando correo de rendición enviada a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: `Rendición enviada para revisión — ${data.reportTitle}`,
        template: './rendicion-submitted',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...data,
          platformUrl: this.resolvePlatformHref(data.platformUrl),
        },
      })
      this.logger.debug(`Correo de rendición enviada enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error correo rendición enviada a ${email}:`, error)
    }
  }

  /** Fase 3 — rechazo al colaborador (Funcionalidades.md §3.1) */
  async sendViaticoRechazoColaborador(
    email: string,
    data: {
      collaboratorName: string
      collaboratorDocument: string
      collaboratorArea: string
      collaboratorCargo: string
      projectLabel: string
      rejectionReason: string
      platformUrl?: string
    }
  ) {
    try {
      const subject = `Rechazo de solicitud de viáticos - ${data.projectLabel}`
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './viatico-rechazo-colaborador',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo rechazo viático enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error rechazo viático a ${email}:`, error)
      throw error
    }
  }

  /** Notificación a Contabilidad cuando una solicitud queda en pending_l2. */
  async sendViaticoPendienteL2(
    email: string,
    data: {
      recipientName: string
      urgent: boolean
      urgentBanner: string
      emailTitle: string
      detailBody: string
      projectLabel: string
      platformUrl?: string
    }
  ) {
    try {
      const prefix = data.urgent ? '[🔴 URGENTE] ' : ''
      const subject = `${prefix}Solicitud pendiente de aprobación final - ${data.projectLabel}`
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './viatico-pendiente-l2',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo pendiente L2 enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error pendiente L2 a ${email}:`, error)
      throw error
    }
  }

  /** Fase 3 — aprobación a contabilidad / tesorería (Funcionalidades.md §3.2) */
  async sendViaticoAprobacionContabilidad(
    email: string,
    data: {
      recipientName: string
      urgent: boolean
      urgentBanner: string
      emailTitle: string
      detailBody: string
      /** Etiqueta N° centro de costo ej. `[CODE - Nombre]` (Fase 3). */
      projectLabel: string
      platformUrl?: string
    }
  ) {
    try {
      const prefix = data.urgent ? '[🔴 URGENTE] ' : ''
      const subject = `${prefix}Solicitud aprobada - ${data.projectLabel}`
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './viatico-aprobacion-contabilidad',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo aprobación viático (contabilidad) enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error aprobación viático a ${email}:`, error)
      throw error
    }
  }

  /** Fase 2 — nueva solicitud de viáticos al coordinador (Funcionalidades.md §2.2) */
  async sendViaticoSolicitudToCoordinator(
    email: string,
    data: {
      coordinatorName: string
      collaboratorName: string
      place: string
      startDate: string
      endDate: string
      totalFormatted: string
      projectLabel: string
      plainSummary: string
      platformUrl?: string
    }
  ) {
    try {
      const subject = `Nueva solicitud de viáticos, ${data.projectLabel}`
      this.logger.debug(`Enviando solicitud de viáticos a coordinador ${email}`)
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './viatico-solicitud-coordinator',
        attachments: [
          {
            filename: 'resumen-solicitud-viaticos.txt',
            content: data.plainSummary,
            contentType: 'text/plain; charset=utf-8',
          },
        ],
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo de solicitud de viáticos enviado a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar solicitud de viáticos a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendViaticoCancelacion(
    email: string,
    data: {
      coordinatorName: string
      collaboratorName: string
      place: string
      startDate: string
      endDate: string
      totalFormatted: string
      projectLabel: string
      plainSummary: string
      cancelReason?: string
      platformUrl?: string
    }
  ) {
    try {
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject: `Solicitud de viáticos cancelada — ${data.projectLabel}`,
        template: './viatico-cancelacion-coordinator',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo cancelación viático enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error al enviar cancelación viático a ${email}:`, error)
    }
  }

  /** Fase 6 — rendición aprobada con saldo a favor del colaborador (pendiente de pago). */
  async sendRendicionReembolsoContabilidad(
    email: string,
    data: {
      recipientName: string
      /** Identificador legible para el asunto (ej. título + ref. corta), alineado a Funcionalidades §6.1 */
      reportLabel: string
      reportTitle: string
      collaboratorName: string
      amountFormatted: string
      detailUrl: string
    }
  ) {
    try {
      const subject = `Rendición «${data.reportLabel}» requiere reembolso de S/ ${data.amountFormatted} a ${data.collaboratorName}`
      const { detailUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './rendicion-reembolso-contabilidad',
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          detailUrl: this.resolvePlatformHref(detailUrl),
        },
      })
    } catch (error) {
      this.logger.error(`Error correo reembolso contabilidad a ${email}:`, error)
      throw error
    }
  }

  /** Fase 6 — reembolso pagado al colaborador (adjunta comprobante). */
  async sendRendicionReembolsoPagado(
    email: string,
    data: {
      recipientName: string
      collaboratorName: string
      coordinatorName?: string
      reportTitle: string
      amountFormatted: string
      transferDate: string
      reference?: string
      paymentMethod: string
      paymentReceiptUrl: string
      paymentReceiptFileName?: string
      platformUrl?: string
    }
  ) {
    try {
      const subject = `Reembolso de gastos registrado — ${data.reportTitle}`
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './rendicion-reembolso-pagado',
        attachments: data.paymentReceiptUrl
          ? [
              {
                filename:
                  data.paymentReceiptFileName ||
                  'comprobante-reembolso-rendicion.pdf',
                path: data.paymentReceiptUrl,
              },
            ]
          : [],
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo reembolso pagado enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error correo reembolso pagado a ${email}:`, error)
      throw error
    }
  }

  /** Fase 4 — pago de viáticos registrado para colaborador y coordinador. */
  async sendViaticoPagoRealizado(
    email: string,
    data: {
      recipientName: string
      collaboratorName: string
      coordinatorName?: string
      projectLabel: string
      amountFormatted: string
      transferDate: string
      reference?: string
      paymentMethod: string
      paymentReceiptUrl: string
      paymentReceiptFileName?: string
      platformUrl?: string
    }
  ) {
    try {
      const subject = `Viáticos aprobados y pagados — ${data.projectLabel}`
      const { platformUrl, ...rest } = data
      await this.mailerService.sendMail({
        to: email,
        subject,
        template: './viatico-pago-realizado',
        attachments: data.paymentReceiptUrl
          ? [
              {
                filename:
                  data.paymentReceiptFileName || 'comprobante-pago-viaticos.pdf',
                path: data.paymentReceiptUrl,
              },
            ]
          : [],
        context: {
          logoUrl: this.getLogoUrl(),
          year: new Date().getFullYear(),
          ...rest,
          platformUrl: this.resolvePlatformHref(platformUrl),
        },
      })
      this.logger.debug(`Correo de pago viático enviado a ${email}`)
    } catch (error) {
      this.logger.error(`Error correo pago viático a ${email}:`, error)
      throw error
    }
  }

  // ─── Fase 8 — Cierre definitivo ──────────────────────────────────────────

  async sendRendicionCerrada(
    email: string,
    data: { recipientName: string; reportTitle: string; closedAt: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Rendición Cerrada Definitivamente — ${data.reportTitle}`,
        template: './rendicion-cerrada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo rendición cerrada a ${email}:`, error)
    }
  }

  async sendRendicionDevolucionColaborador(
    email: string,
    data: { recipientName: string; reportTitle: string; amountFormatted: string; closedAt: string; platformUrl?: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Devolución pendiente — ${data.reportTitle} — S/ ${data.amountFormatted}`,
        template: './rendicion-devolucion-colaborador',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data, platformUrl: this.resolvePlatformHref(data.platformUrl) },
      })
    } catch (error) {
      this.logger.error(`Error correo devolucion colaborador a ${email}:`, error)
    }
  }

  async sendRendicionDevolucionCargada(
    email: string,
    data: { recipientName: string; collaboratorName: string; reportTitle: string; amountFormatted: string; depositDate: string; bankOrigin?: string; operationNumber?: string; platformUrl?: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Comprobante de devolución cargado — ${data.reportTitle} — ${data.collaboratorName}`,
        template: './rendicion-devolucion-cargada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data, platformUrl: this.resolvePlatformHref(data.platformUrl) },
      })
    } catch (error) {
      this.logger.error(`Error correo devolucion cargada a ${email}:`, error)
    }
  }

  async sendRendicionCancelada(
    email: string,
    data: { adminName: string; collaboratorName: string; reportTitle: string; cancelReason?: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Rendición cancelada por el colaborador — ${data.reportTitle}`,
        template: './rendicion-cancelada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo rendición cancelada a ${email}:`, error)
    }
  }

  // ─── Fase 7 — Devolución de saldos ───────────────────────────────────────

  async sendDevolucionPendiente(
    email: string,
    data: { recipientName: string; amountDue: string; dueDate: string; advanceId: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `DEVOLUCIÓN PENDIENTE — Viático N° ${data.advanceId} — Monto S/ ${data.amountDue}`,
        template: './devolucion-pendiente',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo devolución pendiente a ${email}:`, error)
    }
  }

  async sendDevolucionValidada(
    email: string,
    data: { recipientName: string; amountDue: string; advanceId: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Devolución validada — Viático N° ${data.advanceId}`,
        template: './devolucion-validada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo devolución validada a ${email}:`, error)
    }
  }

  async sendDevolucionRechazada(
    email: string,
    data: { recipientName: string; amountDue: string; rejectionReason?: string; advanceId: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Comprobante de devolución rechazado — Viático N° ${data.advanceId}`,
        template: './devolucion-rechazada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo devolución rechazada a ${email}:`, error)
    }
  }

  // ─── Fase 9 — Reembolso Directo ──────────────────────────────────────────

  async sendReembolsoDirectoAbierto(
    email: string,
    data: { recipientName: string; code: string; estimatedAmount: number; justification: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Reembolso Directo Abierto — Código ${data.code}`,
        template: './reembolso-directo-abierto',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo reembolso directo abierto a ${email}:`, error)
    }
  }

  async sendReembolsoDirectoNuevoContabilidad(
    email: string,
    data: { recipientName: string; collaboratorName: string; code: string; estimatedAmount: number; justification: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Nueva solicitud de Reembolso Directo — ${data.code}`,
        template: './reembolso-directo-nuevo-contabilidad',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo reembolso directo contabilidad a ${email}:`, error)
    }
  }

  async sendReembolsoDirectoPagado(
    email: string,
    data: { recipientName: string; code: string; amount: number; receiptUrl: string }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Pago Registrado — Reembolso Directo ${data.code}`,
        template: './reembolso-directo-pagado',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo reembolso directo pagado a ${email}:`, error)
    }
  }

  // ─── Fase 10 — Caja Chica ────────────────────────────────────────────────

  async sendCajaChicaCreada(
    email: string,
    data: { recipientName: string; code: string; period: string; fundAmount: number }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Caja Chica Creada — ${data.code}`,
        template: './caja-chica-creada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo caja chica creada a ${email}:`, error)
    }
  }

  async sendCajaChicaFondeada(
    email: string,
    data: { recipientName: string; code: string; fundAmount: number }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: `Caja Chica Fondeada y Activa — ${data.code}`,
        template: './caja-chica-fondeada',
        context: { logoUrl: this.getLogoUrl(), year: new Date().getFullYear(), ...data },
      })
    } catch (error) {
      this.logger.error(`Error correo caja chica fondeada a ${email}:`, error)
    }
  }
}
