import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FilesService } from '../files/files.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly filesService: FilesService) {}

  /**
   * Every minute, because the upload form hands out timers in minutes: an
   * hourly sweep would leave a "delete after 5 minutes" file on disk for
   * another 55. Lookups still reap lazily, so this is only about the bytes.
   * The query is one indexed scan of a table with a few thousand rows.
   */
  @Interval(60 * 1000)
  async purge(): Promise<void> {
    const removed = await this.filesService.purgeExpired();
    if (removed > 0) {
      this.logger.log(`Purged ${removed} expired file(s)`);
    }
  }
}
