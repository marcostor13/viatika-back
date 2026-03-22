import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument, AuditAction } from './entities/audit-log.entity';

export interface CreateAuditLogDto {
  userId: string;
  userName: string;
  action: AuditAction;
  module: string;
  entityId?: string;
  details?: string;
  clientId?: string;
  ip?: string;
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  async log(data: CreateAuditLogDto): Promise<void> {
    try {
      await this.auditLogModel.create(data);
    } catch {
      // Logging errors must never break the main flow
    }
  }

  async findAll(clientId?: string, limit = 200) {
    const filter: any = {};
    if (clientId) filter.clientId = clientId;
    return this.auditLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }
}
