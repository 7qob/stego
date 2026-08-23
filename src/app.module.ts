import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupModule } from './cleanup/cleanup.module';
import { DbModule } from './db/db.module';
import { FilesModule } from './files/files.module';
import { RemoteModule } from './remote/remote.module';
import { StegoModule } from './stego/stego.module';
import { UploadModule } from './upload/upload.module';
import { ViewsModule } from './views/views.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DbModule,
    ViewsModule,
    FilesModule,
    UploadModule,
    RemoteModule,
    StegoModule,
    CleanupModule,
  ],
})
export class AppModule {}
