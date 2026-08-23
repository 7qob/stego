import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [FilesModule],
  providers: [CleanupService],
})
export class CleanupModule {}
