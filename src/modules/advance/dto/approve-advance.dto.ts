import { IsString, IsOptional } from 'class-validator'

export class ApproveAdvanceDto {
  @IsString()
  @IsOptional()
  notes?: string

  // Seteado desde el JWT
  approvedBy?: string
}

export class RejectAdvanceDto {
  @IsString()
  rejectionReason: string

  // Seteado desde el JWT
  rejectedBy?: string
}
