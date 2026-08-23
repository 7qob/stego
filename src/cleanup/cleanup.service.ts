import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { config } from '../config/config';
import { FilesService } from '../files/files.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly filesService: FilesService) {}

  /** Hourly is plenty — expiry is also enforced lazily on every lookup. */
  @Interval(60 * 60 * 1000)
  async purge(): Promise<void> {
    if (config.retentionMs === 0) return;

    const removed = await this.filesService.purgeExpired();
    if (removed > 0) {
      this.logger.log(`Purged ${removed} expired file(s)`);
    }
  }
}
