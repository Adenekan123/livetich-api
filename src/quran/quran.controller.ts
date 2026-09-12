import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { AllowRecorder } from '../auth/jwt-auth.guard';
import { PLUGIN_ISLAMIC_EDUCATION } from '../plugins/catalog';
import {
  RequirePlugin,
  RequirePluginGuard,
} from '../plugins/require-plugin.guard';
import { getSurahAyahs } from './quran-text';
import { SURAHS, TOTAL_AYAHS } from './surahs';

/**
 * Serves the static surah catalog so the web app can render memorization
 * pickers without shipping the 114-entry table itself, plus the full verse
 * text of a single surah for the live mushaf reader. Authed (global guard)
 * and gated on the Islamic Education pack — the same reference data for every
 * org that has the pack on, but not course-scoped.
 */
@Controller('quran')
// The recorder reads the mushaf too. This is fixed reference data — the same
// text for every org with the pack — so letting a recorder token read it gives
// away nothing about anyone, and refusing it left a recorded hifz lesson
// showing "Could not load surah" where the ayah should be.
@AllowRecorder()
@UseGuards(RequirePluginGuard)
@RequirePlugin(PLUGIN_ISLAMIC_EDUCATION)
export class QuranController {
  @Get('surahs')
  surahs() {
    return { surahs: SURAHS, totalAyahs: TOTAL_AYAHS };
  }

  /** Uthmani verse text for one surah, for the shared reader. */
  @Get('surahs/:number')
  surah(@Param('number', ParseIntPipe) number: number) {
    if (number < 1 || number > SURAHS.length) {
      throw new BadRequestException('Surah number must be between 1 and 114');
    }
    const ayahs = getSurahAyahs(number);
    if (!ayahs) throw new NotFoundException('Surah text not found');
    const meta = SURAHS[number - 1];
    return {
      number,
      arabicName: meta.arabicName,
      transliteration: meta.transliteration,
      englishName: meta.englishName,
      ayahs,
    };
  }
}
