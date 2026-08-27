import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { UnlockService } from './unlock.service';
import { RateLimitService } from '../privacy/rate-limit';
import { ViewsModule } from '../views/views.module';

@Module({
  imports: [ViewsModule],
  controllers: [FilesController],
  providers: [FilesService, UnlockService, RateLimitService],
  exports: [FilesService, UnlockService, RateLimitService],
})
export class FilesModule {}
