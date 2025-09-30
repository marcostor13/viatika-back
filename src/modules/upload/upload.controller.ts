import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  BadRequestException,
  Delete,
  Param,
  FileTypeValidator
} from '@nestjs/common';
import { UploadService } from './upload.service';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) { }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })) // 'file' debe coincidir con el nombre del campo en el FormData del frontend
  async uploadImage(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB max
          // Acepta imágenes, videos y audio por mimetype o extensión
          new FileTypeValidator({ fileType: /(^image\/.*$)|(^video\/.*$)|(^audio\/.*$)|(\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff|mp4|mov|avi|mkv|webm|mpeg|mpg|m4v|3gp|3g2|flv|wmv|ts|m2ts|ogv|mp3|wav|aac|ogg|m4a|flac|wma|aiff|opus)$)/i }),
        ],
        exceptionFactory: (errors) => {
          throw new BadRequestException(errors)
        }
      })
    )
    file: Express.Multer.File,
  ): Promise<{ url: string }> {
    const fileName = `${Date.now()}-${file.originalname}`;
    const fileUrl = await this.uploadService.uploadImage(file, fileName);
    return { url: fileUrl };
  }

  @Delete(':key')
  async deleteFile(@Param('key') key: string) {
    return this.uploadService.deleteFile(key);
  }



}
