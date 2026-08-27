import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { CleanupModule } from './cleanup/cleanup.module';
import { DbModule } from './db/db.module';
import { FilesModule } from './files/files.module';
import { MetaModule } from './meta/meta.module';
import { RemoteModule } from './remote/remote.module';
import { StegoModule } from './stego/stego.module';
import { StorageModule } from './storage/storage.module';
import { UploadModule } from './upload/upload.module';
import { ViewsModule } from './views/views.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DbModule,
    StorageModule,
    ViewsModule,
    FilesModule,
    UploadModule,
    RemoteModule,
    StegoModule,
    MetaModule,
    AdminModule,
    CleanupModule,
  ],
})
export class AppModule {}
