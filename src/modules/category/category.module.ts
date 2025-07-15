import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Category, CategorySchema } from './entities/category.entity'
import { CategoryService } from './category.service'
import { CategoryController } from './category.controller'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
    ]),
  ],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [CategoryService, MongooseModule],
})
export class CategoryModule {}
