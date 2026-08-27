import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { AdminAuthService } from './admin.auth';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminViewsService } from './admin.views';

/**
 * The path rewrite that makes `STEGO_ADMIN_PATH` work lives in
 * `admin-path.ts` and is installed in main.ts, because it has to run ahead of
 * the Nest router rather than inside it.
 */
@Module({
  imports: [FilesModule],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminViewsService, AdminGuard],
  exports: [AdminAuthService],
})
export class AdminModule {}
