import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsMongoId,
} from 'class-validator'

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
}
