import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { StegoService } from './stego.service';

/**
 * Carrier images are held in memory (they must be decoded to raw pixels
 * anyway), so the cap here is deliberately much lower than the upload cap.
 */
const CARRIER_LIMIT = 32 * 1024 * 1024;

const carrierUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: CARRIER_LIMIT, files: 1 },
});

@Controller('api/stego')
export class StegoController {
  constructor(private readonly stegoService: StegoService) {}

  @Post('capacity')
  @UseInterceptors(carrierUpload)
  async capacity(@UploadedFile() file?: Express.Multer.File) {
    requireImage(file);
    return { capacityBytes: await this.stegoService.capacity(file!.buffer) };
  }

  @Post('encode')
  @UseInterceptors(carrierUpload)
  async encode(
    @Body('message') message: string,
    @Body('password') password: string | undefined,
    @Res() res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<void> {
    requireImage(file);
    if (!message?.trim()) throw new BadRequestException('Missing "message" field');

    const result = await this.stegoService.encode(file!.buffer, message, password || undefined);

    // Always PNG out, whatever went in — see the note in stego.service.ts.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="stego.png"');
    res.setHeader('X-Stego-Capacity', String(result.capacityBytes));
    res.setHeader('X-Stego-Used', String(result.usedBytes));
    res.send(result.image);
  }

  @Post('decode')
  @UseInterceptors(carrierUpload)
  async decode(
    @Body('password') password: string | undefined,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    requireImage(file);
    return { message: await this.stegoService.decode(file!.buffer, password || undefined) };
  }
}

function requireImage(file?: Express.Multer.File): void {
  if (!file) throw new BadRequestException('No image provided (field name must be "file")');
  if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Not an image');
}
