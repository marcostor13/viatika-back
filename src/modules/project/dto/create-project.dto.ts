import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator'

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name: string

  @IsString()
  @IsOptional()
  code?: string

  @IsBoolean()
  @IsOptional()
  isActive?: boolean

  @IsString()
  @IsNotEmpty()
  clientId: string

  @IsString()
  @IsOptional()
  clientName?: string

  @IsString()
  @IsOptional()
  lineaNegocioId?: string

  // Obligatorio en el endpoint HTTP (@IsNotEmpty rechaza vacío/ausente).
  // El tipo se deja opcional para no romper llamadas directas internas (seed, tests).
  @IsString()
  @IsNotEmpty({ message: 'El perfil de categoría es obligatorio' })
  categoryGroupId?: string

  // --- Mapeo contable (asientos Contanet) ---
  @IsString()
  @IsOptional()
  cuentaAnalitica9x?: string

  @IsString()
  @IsOptional()
  cuentaDestino6x?: string

  @IsString()
  @IsOptional()
  centroCosto?: string

  @IsString()
  @IsOptional()
  subCentroCosto?: string

  @IsString()
  @IsOptional()
  area?: string

  @IsBoolean()
  @IsOptional()
  esAdministrativo?: boolean
}
