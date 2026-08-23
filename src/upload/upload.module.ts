import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [FilesModule],
  controllers: [UploadController],
})
export class UploadModule {}
