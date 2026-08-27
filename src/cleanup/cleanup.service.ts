import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { readdir } from 'node:fs/promises';
import { config } from '../config/config';
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
   *
   * Worst case a file nobody requests survives its deadline by up to a minute
   * — the sweep's phase, not a bug. Anyone who asks for it in that window
   * gets a 404 and triggers the reap themselves.
   */
  @Interval(60 * 1000)
  async purge(): Promise<void> {
    const removed = await this.filesService.purgeExpired();
    if (removed > 0) {
      this.logger.log(`Purged ${removed} expired file(s)`);
    }
  }

  /**
   * Blobs with no row pointing at them.
   *
   * A crash between multer writing the file and the INSERT landing leaves
   * one behind, and so does a failed upload that the error path could not
   * clean up. On an ordinary file host that is wasted disk. Here it is worse
   * than that: it is user data that outlived the deletion the user asked
   * for, sitting in the uploads directory indefinitely.
   *
   * Hourly rather than per-minute because it lists a directory, and half an
   * hour of grace also keeps it from racing an upload that is mid-flight.
   */
  @Interval(60 * 60 * 1000)
  async purgeOrphans(): Promise<void> {
    try {
      const entries = await readdir(config.uploadDir);
      const candidates = entries.filter((name) => !name.endsWith('.sealing'));

      const removed = await this.filesService.purgeOrphans(candidates);
      if (removed > 0) {
        this.logger.log(`Removed ${removed} orphaned blob(s)`);
      }
    } catch (error) {
      this.logger.warn(`Orphan sweep failed: ${String(error)}`);
    }
  }
}
