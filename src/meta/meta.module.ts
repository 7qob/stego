import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { MetaController } from './meta.controller';

@Module({
  imports: [FilesModule],
  controllers: [MetaController],
})
export class MetaModule {}
