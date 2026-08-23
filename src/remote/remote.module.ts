import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';

@Module({
  imports: [FilesModule],
  controllers: [RemoteController],
  providers: [RemoteService],
})
export class RemoteModule {}
