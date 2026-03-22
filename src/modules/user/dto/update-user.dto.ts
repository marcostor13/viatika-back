import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsMongoId,
  IsArray,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

export class UpdatePermissionsDto {
  @IsArray()
  @IsOptional()
  modules?: string[]

  @IsBoolean()
  @IsOptional()
  canApproveL1?: boolean

  @IsBoolean()
  @IsOptional()
  canApproveL2?: boolean
}

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  name?: string

  @IsEmail()
  @IsOptional()
  email?: string

  @IsString()
  @IsOptional()
  password?: string

  @IsMongoId()
  @IsOptional()
  roleId?: string

  @IsBoolean()
  @IsOptional()
  isActive?: boolean

  @IsMongoId()
  @IsOptional()
  clientId?: string

  @IsString()
  @IsOptional()
  dni?: string

  @IsString()
  @IsOptional()
  employeeCode?: string

  @IsString()
  @IsOptional()
  address?: string

  @IsString()
  @IsOptional()
  phone?: string

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdatePermissionsDto)
  permissions?: UpdatePermissionsDto
}
