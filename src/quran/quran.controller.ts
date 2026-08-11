import { Controller, Get } from '@nestjs/common';
import { SURAHS, TOTAL_AYAHS } from './surahs';

/**
 * Serves the static surah catalog so the web app can render memorization
 * pickers without shipping the 114-entry table itself. Authed (global guard)
 * but not course-scoped — it's the same reference data for everyone.
 */
@Controller('quran')
export class QuranController {
  @Get('surahs')
  surahs() {
    return { surahs: SURAHS, totalAyahs: TOTAL_AYAHS };
  }
}
