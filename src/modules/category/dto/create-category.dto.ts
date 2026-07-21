import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsBoolean,
  IsNumber,
  Min,
  IsArray,
  IsIn,
} from 'class-validator'

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string

  @IsString()
  @IsOptional()
  key?: string

  @IsString()
  @IsOptional()
  description?: string

  @IsString()
  @IsOptional()
  cuenta?: string

  @IsString()
  @IsOptional()
  cuentaDestino6x?: string

  @IsString()
  @IsOptional()
  observaciones?: string

  @IsBoolean()
  @IsOptional()
  isActive?: boolean

  @IsNumber()
  @Min(0)
  @IsOptional()
  limit?: number | null

  /**
   * Rubro de Declaración Jurada al que se autoasigna esta categoría.
   * `null` limpia el flag. Solo una categoría por perfil debería llevar cada valor.
   */
  @IsOptional()
  @IsIn(['alimentacion', 'movilidad'])
  djType?: 'alimentacion' | 'movilidad' | null

  @IsString()
  @IsNotEmpty()
  clientId: string

  /** Perfiles de categoría a los que pertenece (M:N). */
  @IsArray()
  @IsOptional()
  perfilIds?: string[]
}
