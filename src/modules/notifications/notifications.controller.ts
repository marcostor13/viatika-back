import { Controller, Get, Post, Body, Patch, Param, UseGuards, Req } from '@nestjs/common'
import { NotificationsService } from './notifications.service'
import { CreateNotificationDto } from './dto/create-notification.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  create(@Body() createNotificationDto: CreateNotificationDto) {
    return this.notificationsService.create(createNotificationDto)
  }

  @Get()
  findAll(@Req() req: any) {
    const userId = req.user['userId'] || req.user['_id'] || req.user['id']
    console.log(`[NotificationsController] Getting notifications for userId (from tag): ${userId}`);
    return this.notificationsService.findByUser(userId)
  }

  @Get('unread-count')
  getUnreadCount(@Req() req: any) {
    const userId = req.user['userId'] || req.user['_id'] || req.user['id']
    console.log(`[NotificationsController] Getting unread count for userId: ${userId}`);
    return this.notificationsService.getUnreadCount(userId).then(count => ({ count }))
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    const userId = req.user['userId'] || req.user['_id'] || req.user['id']
    return this.notificationsService.findOne(id, userId)
  }

  @Patch('read-all')
  markAllAsRead(@Req() req: any) {
    const userId = req.user['userId'] || req.user['_id'] || req.user['id']
    return this.notificationsService.markAllAsRead(userId)
  }

  @Patch(':id/read')
  markAsRead(@Param('id') id: string, @Req() req: any) {
    const userId = req.user['userId'] || req.user['_id'] || req.user['id']
    return this.notificationsService.markAsRead(id, userId)
  }
}
