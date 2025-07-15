import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import {
  SunatConfig,
  SunatConfigDocument,
} from './entities/sunat-config.entity'
import { CreateSunatConfigDto } from './dto/create-sunat-config.dto'
import { UpdateSunatConfigDto } from './dto/update-sunat-config.dto'

@Injectable()
export class SunatConfigService {
  private readonly logger = new Logger(SunatConfigService.name)

  constructor(
    @InjectModel(SunatConfig.name)
    private sunatConfigModel: Model<SunatConfigDocument>
  ) { }

  async create(createSunatConfigDto: CreateSunatConfigDto) {
    try {
      this.logger.log(
        `Creando configuración SUNAT para clientId: ${createSunatConfigDto.clientId}`
      )

      // Verificar si ya existe configuración para esta empresa
      const existingConfig = await this.sunatConfigModel
        .findOne({ clientId: createSunatConfigDto.clientId })
        .exec()
      if (existingConfig) {
        this.logger.warn(
          `Ya existe configuración SUNAT para clientId: ${createSunatConfigDto.clientId}`
        )
        throw new Error('Ya existe configuración SUNAT para esta empresa')
      }

      const sunatConfig = new this.sunatConfigModel({
        ...createSunatConfigDto,
      })

      const result = await sunatConfig.save()
      this.logger.log(
        `Configuración SUNAT creada exitosamente para clientId: ${createSunatConfigDto.clientId}`
      )

      return result
    } catch (error) {
      this.logger.error(
        `Error al crear configuración SUNAT: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async findOne(clientId: string) {
    try {
      this.logger.log(
        `Buscando configuración SUNAT para clientId: ${clientId}`
      )

      const config = await this.sunatConfigModel.findOne({ clientId }).exec()
      if (!config) {
        this.logger.warn(
          `No se encontró configuración SUNAT para clientId: ${clientId}`
        )
        throw new NotFoundException('No se encontró configuración SUNAT')
      }

      return config
    } catch (error) {
      this.logger.error(
        `Error al buscar configuración SUNAT: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async update(_id: string, updateSunatConfigDto: UpdateSunatConfigDto) {
    try {

      const config = await this.sunatConfigModel
        .findOneAndUpdate(
          { _id },
          { $set: updateSunatConfigDto },
          { new: true }
        )
        .exec()

      if (!config) {
        this.logger.warn(
          `No se encontró configuración SUNAT para clientId: ${updateSunatConfigDto.clientId}`
        )
        throw new NotFoundException('No se encontró configuración SUNAT')
      }

      this.logger.log(
        `Configuración SUNAT actualizada exitosamente para clientId: ${updateSunatConfigDto.clientId}`
      )
      return config
    } catch (error) {
      this.logger.error(
        `Error al actualizar configuración SUNAT: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async remove(_id: string) {
    try {

      const result = await this.sunatConfigModel
        .findOneAndDelete({ _id })
        .exec()
      if (!result) {
        throw new NotFoundException('No se encontró configuración SUNAT')
      }
      return result
    } catch (error) {

      throw new NotFoundException('Error al eliminar configuración SUNAT')
    }
  }

  // Método para obtener credenciales activas
  async getActiveCredentials(clientId: string) {
    try {
      this.logger.log(
        `Obteniendo credenciales SUNAT activas para clientId: ${clientId}`
      )

      const config = await this.sunatConfigModel
        .findOne({
          clientId,
          isActive: true,
        })
        .exec()

      if (!config) {
        this.logger.warn(
          `No se encontraron credenciales SUNAT activas para clientId: ${clientId}`
        )
        throw new NotFoundException(
          'No se encontraron credenciales SUNAT activas'
        )
      }

      return {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }
    } catch (error) {
      this.logger.error(
        `Error al obtener credenciales SUNAT: ${error.message}`,
        error.stack
      )
      throw error
    }
  }
}
