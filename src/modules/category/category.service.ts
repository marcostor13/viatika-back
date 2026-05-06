import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Category, CategoryDocument } from './entities/category.entity'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'

export interface IPaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pages: number
  limit: number
}

export interface ICategoryWithChildren {
  _id: string
  name: string
  key: string
  description?: string
  isActive: boolean
  limit: number | null
  clientId: Types.ObjectId
  parentId: Types.ObjectId | null
  children: CategoryDocument[]
  createdAt: Date
  updatedAt: Date
}

@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name)

  constructor(
    @InjectModel(Category.name)
    private categoryModel: Model<CategoryDocument>
  ) {}

  async create(
    createCategoryDto: CreateCategoryDto
  ): Promise<CategoryDocument> {
    const clientIdObject = new Types.ObjectId(createCategoryDto.clientId)
    try {
      let parentId: Types.ObjectId | null = null
      let keyPrefix: string | undefined

      if (createCategoryDto.parentId) {
        parentId = new Types.ObjectId(createCategoryDto.parentId)
        const parent = await this.categoryModel
          .findOne({ _id: parentId, clientId: clientIdObject })
          .exec()
        if (!parent) {
          throw new NotFoundException(
            `Categoría padre con ID ${createCategoryDto.parentId} no encontrada`
          )
        }
        keyPrefix = parent.key
      }

      if (!createCategoryDto.key && createCategoryDto.name) {
        createCategoryDto.key = this.generateKey(
          createCategoryDto.name,
          keyPrefix
        )
      }

      const newCategory = new this.categoryModel({
        ...createCategoryDto,
        clientId: clientIdObject,
        parentId,
      })
      return await newCategory.save()
    } catch (error) {
      this.logger.error(
        `Error al crear categoría: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async findAll(
    clientId: string,
    options: { page?: number; limit?: number; search?: string } = {}
  ): Promise<IPaginatedResult<ICategoryWithChildren>> {
    const clientIdObject = new Types.ObjectId(clientId)
    const page = options.page && options.page > 0 ? options.page : 1
    const limit = options.limit && options.limit > 0 ? options.limit : 20
    const skip = (page - 1) * limit

    try {
      const filter: Record<string, unknown> = {
        clientId: clientIdObject,
        parentId: null,
      }

      if (options.search) {
        filter.name = { $regex: options.search, $options: 'i' }
      }

      const total = await this.categoryModel.countDocuments(filter).exec()
      const parents = await this.categoryModel
        .find(filter)
        .skip(skip)
        .limit(limit)
        .exec()

      const data: ICategoryWithChildren[] = await Promise.all(
        parents.map(async (parent) => {
          const children = await this.categoryModel
            .find({ clientId: clientIdObject, parentId: parent._id })
            .exec()

          const doc = parent.toObject() as CategoryDocument & {
            _id: Types.ObjectId
          }
          return {
            _id: doc._id.toString(),
            name: doc.name,
            key: doc.key,
            description: doc.description,
            isActive: doc.isActive,
            limit: doc.limit ?? null,
            clientId: doc.clientId,
            parentId: doc.parentId,
            children,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          }
        })
      )

      return {
        data,
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      }
    } catch (error) {
      this.logger.error(
        `Error al obtener categorías: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async findAllFlat(clientId: string): Promise<CategoryDocument[]> {
    const clientIdObject = new Types.ObjectId(clientId)
    try {
      return await this.categoryModel
        .find({ clientId: clientIdObject })
        .exec()
    } catch (error) {
      this.logger.error(
        `Error al obtener categorías (flat): ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async findOne(id: string, clientId: string): Promise<CategoryDocument> {
    const clientIdObject = new Types.ObjectId(clientId)
    try {
      const category = await this.categoryModel
        .findOne({ _id: id, clientId: clientIdObject })
        .exec()
      if (!category) {
        throw new NotFoundException(`Categoría con ID ${id} no encontrada`)
      }
      return category
    } catch (error) {
      this.logger.error(
        `Error al obtener categoría: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async findByKey(key: string, clientId: string): Promise<CategoryDocument> {
    const clientIdObject = new Types.ObjectId(clientId)
    try {
      const category = await this.categoryModel
        .findOne({ key, clientId: clientIdObject })
        .exec()
      if (!category) {
        throw new NotFoundException(`Categoría con clave ${key} no encontrada`)
      }
      return category
    } catch (error) {
      this.logger.error(
        `Error al obtener categoría por clave: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async update(
    id: string,
    updateCategoryDto: UpdateCategoryDto,
    clientId: string
  ): Promise<CategoryDocument> {
    const clientIdObject = new Types.ObjectId(clientId)
    try {
      if (
        updateCategoryDto.name &&
        !updateCategoryDto.key &&
        updateCategoryDto.name !== (await this.findOne(id, clientId)).name
      ) {
        updateCategoryDto.key = this.generateKey(updateCategoryDto.name)
      }

      const updatedCategory = await this.categoryModel
        .findOneAndUpdate(
          { _id: id, clientId: clientIdObject },
          updateCategoryDto,
          {
            new: true,
          }
        )
        .exec()

      if (!updatedCategory) {
        throw new NotFoundException(`Categoría con ID ${id} no encontrada`)
      }

      return updatedCategory
    } catch (error) {
      this.logger.error(
        `Error al actualizar categoría: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async remove(id: string, clientId: string): Promise<void> {
    const clientIdObject = new Types.ObjectId(clientId)
    try {
      const result = await this.categoryModel
        .findOneAndDelete({ _id: id, clientId: clientIdObject })
        .exec()
      if (!result) {
        throw new NotFoundException(`Categoría con ID ${id} no encontrada`)
      }
      await this.categoryModel.deleteMany({ parentId: result._id, clientId: clientIdObject }).exec()
    } catch (error) {
      this.logger.error(
        `Error al eliminar categoría: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  private generateKey(name: string, prefix?: string): string {
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    return prefix ? `${prefix}-${slug}` : slug
  }
}
