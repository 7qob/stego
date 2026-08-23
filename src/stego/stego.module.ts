import { Module } from '@nestjs/common';
import { StegoController } from './stego.controller';
import { StegoService } from './stego.service';

@Module({
  controllers: [StegoController],
  providers: [StegoService],
  exports: [StegoService],
})
export class StegoModule {}
