import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsMongoId,
  MinLength,
  IsBoolean,
} from 'class-validator'

export class CreateUserDto {

  @IsString()
  @IsNotEmpty()
  name: string

  @IsNotEmpty()
  email: string

  @IsString()
  @MinLength(6)
  @IsNotEmpty()
  password: string

  @IsNotEmpty()
  roleId: string

  @IsString()

  @IsMongoId()
  @IsNotEmpty()
  clientId: string

  @IsBoolean()
  @IsOptional()
  isActive?: boolean
}
