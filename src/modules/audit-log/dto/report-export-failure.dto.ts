import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

class FailedAttachmentDto {
  /** Código del comprobante (FT, BV, RD…) o etiqueta equivalente. */
  @IsString()
  @MaxLength(40)
  label: string

  @IsString()
  @MaxLength(500)
  url: string

  /** Motivo técnico del fallo tal como lo vio el navegador. */
  @IsString()
  @MaxLength(300)
  reason: string
}

/**
 * Lo que el navegador reporta cuando el "PDF completo" no logra descargar el
 * archivo de un comprobante. Sirve para diagnosticar los casos que solo se
 * reproducen en el equipo del colaborador (CORS, red, navegador antiguo).
 */
export class ReportExportFailureDto {
  @IsString()
  @MaxLength(60)
  reportId: string

  @IsOptional()
  @IsString()
  @MaxLength(60)
  reportCode?: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FailedAttachmentDto)
  attachments: FailedAttachmentDto[]
}
