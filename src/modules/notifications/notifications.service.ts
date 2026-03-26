import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Notification, NotificationDocument } from './entities/notification.entity'
import { CreateNotificationDto } from './dto/create-notification.dto'

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    @InjectModel(Notification.name)
    private notificationModel: Model<NotificationDocument>
  ) {}

  async create(createDto: CreateNotificationDto): Promise<NotificationDocument> {
    try {
      const created = new this.notificationModel(createDto)
      return await created.save()
    } catch (error) {
      this.logger.error('Error creating notification', error)
      throw error
    }
  }

  async findByUser(userId: string): Promise<NotificationDocument[]> {
    const notifs = await this.notificationModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(50) // limit to recent 50
      .exec()
    console.log(`[NotificationsService] Found ${notifs.length} notifications for ${userId}`);
    return notifs;
  }

  async getUnreadCount(userId: string): Promise<number> {
    const count = await this.notificationModel.countDocuments({
      userId: new Types.ObjectId(userId),
      isRead: false
    }).exec()
    console.log(`[NotificationsService] Unread count for ${userId}: ${count}`);
    return count;
  }

  async findOne(id: string, userId: string): Promise<NotificationDocument | null> {
    return this.notificationModel.findOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId)
    }).exec()
  }

  async markAsRead(id: string, userId: string): Promise<NotificationDocument | null> {
    return this.notificationModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) },
      { $set: { isRead: true } },
      { new: true }
    ).exec()
  }

  async markAllAsRead(userId: string): Promise<{ modifiedCount: number }> {
    const result = await this.notificationModel.updateMany(
      { userId: new Types.ObjectId(userId), isRead: false },
      { $set: { isRead: true } }
    ).exec()
    return { modifiedCount: result.modifiedCount }
  }
}
