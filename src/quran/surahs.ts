/**
 * Static Qur'an surah catalog (Hafs / standard Kufic ayah counts, total 6236).
 * This is factual reference data, not scripture text — we only need surah
 * metadata and ayah counts to let instructors target memorization ranges.
 * Array index + 1 == surah number.
 */
export type Revelation = 'Meccan' | 'Medinan';

export interface Surah {
  number: number;
  arabicName: string;
  transliteration: string;
  englishName: string;
  ayahCount: number;
  revelation: Revelation;
}

// The 28 surahs of the standard (Egyptian) Medinan classification.
const MEDINAN = new Set([
  2, 3, 4, 5, 8, 9, 13, 22, 24, 33, 47, 48, 49, 55, 57, 58, 59, 60, 61, 62, 63,
  64, 65, 66, 76, 98, 99, 110,
]);

// [arabicName, transliteration, englishName, ayahCount]
const RAW: [string, string, string, number][] = [
  ['الفاتحة', 'Al-Fatihah', 'The Opening', 7],
  ['البقرة', 'Al-Baqarah', 'The Cow', 286],
  ['آل عمران', "Aal-E-Imran", 'The Family of Imran', 200],
  ['النساء', 'An-Nisa', 'The Women', 176],
  ['المائدة', "Al-Ma'idah", 'The Table Spread', 120],
  ['الأنعام', "Al-An'am", 'The Cattle', 165],
  ['الأعراف', "Al-A'raf", 'The Heights', 206],
  ['الأنفال', 'Al-Anfal', 'The Spoils of War', 75],
  ['التوبة', 'At-Tawbah', 'The Repentance', 129],
  ['يونس', 'Yunus', 'Jonah', 109],
  ['هود', 'Hud', 'Hud', 123],
  ['يوسف', 'Yusuf', 'Joseph', 111],
  ['الرعد', "Ar-Ra'd", 'The Thunder', 43],
  ['إبراهيم', 'Ibrahim', 'Abraham', 52],
  ['الحجر', 'Al-Hijr', 'The Rocky Tract', 99],
  ['النحل', 'An-Nahl', 'The Bee', 128],
  ['الإسراء', 'Al-Isra', 'The Night Journey', 111],
  ['الكهف', 'Al-Kahf', 'The Cave', 110],
  ['مريم', 'Maryam', 'Mary', 98],
  ['طه', 'Ta-Ha', 'Ta-Ha', 135],
  ['الأنبياء', 'Al-Anbiya', 'The Prophets', 112],
  ['الحج', 'Al-Hajj', 'The Pilgrimage', 78],
  ['المؤمنون', "Al-Mu'minun", 'The Believers', 118],
  ['النور', 'An-Nur', 'The Light', 64],
  ['الفرقان', 'Al-Furqan', 'The Criterion', 77],
  ['الشعراء', "Ash-Shu'ara", 'The Poets', 227],
  ['النمل', 'An-Naml', 'The Ant', 93],
  ['القصص', 'Al-Qasas', 'The Stories', 88],
  ['العنكبوت', 'Al-Ankabut', 'The Spider', 69],
  ['الروم', 'Ar-Rum', 'The Romans', 60],
  ['لقمان', 'Luqman', 'Luqman', 34],
  ['السجدة', 'As-Sajdah', 'The Prostration', 30],
  ['الأحزاب', 'Al-Ahzab', 'The Combined Forces', 73],
  ['سبأ', 'Saba', 'Sheba', 54],
  ['فاطر', 'Fatir', 'Originator', 45],
  ['يس', 'Ya-Sin', 'Ya-Sin', 83],
  ['الصافات', 'As-Saffat', 'Those who set the Ranks', 182],
  ['ص', 'Sad', 'The Letter Sad', 88],
  ['الزمر', 'Az-Zumar', 'The Troops', 75],
  ['غافر', 'Ghafir', 'The Forgiver', 85],
  ['فصلت', 'Fussilat', 'Explained in Detail', 54],
  ['الشورى', 'Ash-Shura', 'The Consultation', 53],
  ['الزخرف', 'Az-Zukhruf', 'The Ornaments of Gold', 89],
  ['الدخان', 'Ad-Dukhan', 'The Smoke', 59],
  ['الجاثية', 'Al-Jathiyah', 'The Crouching', 37],
  ['الأحقاف', 'Al-Ahqaf', 'The Wind-Curved Sandhills', 35],
  ['محمد', 'Muhammad', 'Muhammad', 38],
  ['الفتح', 'Al-Fath', 'The Victory', 29],
  ['الحجرات', 'Al-Hujurat', 'The Rooms', 18],
  ['ق', 'Qaf', 'The Letter Qaf', 45],
  ['الذاريات', 'Adh-Dhariyat', 'The Winnowing Winds', 60],
  ['الطور', 'At-Tur', 'The Mount', 49],
  ['النجم', 'An-Najm', 'The Star', 62],
  ['القمر', 'Al-Qamar', 'The Moon', 55],
  ['الرحمن', 'Ar-Rahman', 'The Beneficent', 78],
  ['الواقعة', "Al-Waqi'ah", 'The Inevitable', 96],
  ['الحديد', 'Al-Hadid', 'The Iron', 29],
  ['المجادلة', 'Al-Mujadila', 'The Pleading Woman', 22],
  ['الحشر', 'Al-Hashr', 'The Exile', 24],
  ['الممتحنة', 'Al-Mumtahanah', 'She that is to be examined', 13],
  ['الصف', 'As-Saff', 'The Ranks', 14],
  ['الجمعة', "Al-Jumu'ah", 'The Congregation, Friday', 11],
  ['المنافقون', 'Al-Munafiqun', 'The Hypocrites', 11],
  ['التغابن', 'At-Taghabun', 'The Mutual Disillusion', 18],
  ['الطلاق', 'At-Talaq', 'The Divorce', 12],
  ['التحريم', 'At-Tahrim', 'The Prohibition', 12],
  ['الملك', 'Al-Mulk', 'The Sovereignty', 30],
  ['القلم', 'Al-Qalam', 'The Pen', 52],
  ['الحاقة', 'Al-Haqqah', 'The Reality', 52],
  ['المعارج', "Al-Ma'arij", 'The Ascending Stairways', 44],
  ['نوح', 'Nuh', 'Noah', 28],
  ['الجن', 'Al-Jinn', 'The Jinn', 28],
  ['المزمل', 'Al-Muzzammil', 'The Enshrouded One', 20],
  ['المدثر', 'Al-Muddaththir', 'The Cloaked One', 56],
  ['القيامة', 'Al-Qiyamah', 'The Resurrection', 40],
  ['الإنسان', 'Al-Insan', 'Man', 31],
  ['المرسلات', 'Al-Mursalat', 'The Emissaries', 50],
  ['النبأ', 'An-Naba', 'The Tidings', 40],
  ['النازعات', "An-Nazi'at", 'Those who drag forth', 46],
  ['عبس', 'Abasa', 'He Frowned', 42],
  ['التكوير', 'At-Takwir', 'The Overthrowing', 29],
  ['الانفطار', 'Al-Infitar', 'The Cleaving', 19],
  ['المطففين', 'Al-Mutaffifin', 'The Defrauding', 36],
  ['الانشقاق', 'Al-Inshiqaq', 'The Sundering', 25],
  ['البروج', 'Al-Buruj', 'The Mansions of the Stars', 22],
  ['الطارق', 'At-Tariq', 'The Nightcomer', 17],
  ['الأعلى', "Al-A'la", 'The Most High', 19],
  ['الغاشية', 'Al-Ghashiyah', 'The Overwhelming', 26],
  ['الفجر', 'Al-Fajr', 'The Dawn', 30],
  ['البلد', 'Al-Balad', 'The City', 20],
  ['الشمس', 'Ash-Shams', 'The Sun', 15],
  ['الليل', 'Al-Layl', 'The Night', 21],
  ['الضحى', 'Ad-Duha', 'The Morning Hours', 11],
  ['الشرح', 'Ash-Sharh', 'The Relief', 8],
  ['التين', 'At-Tin', 'The Fig', 8],
  ['العلق', 'Al-Alaq', 'The Clot', 19],
  ['القدر', 'Al-Qadr', 'The Power', 5],
  ['البينة', 'Al-Bayyinah', 'The Clear Proof', 8],
  ['الزلزلة', 'Az-Zalzalah', 'The Earthquake', 8],
  ['العاديات', 'Al-Adiyat', 'The Courser', 11],
  ['القارعة', "Al-Qari'ah", 'The Calamity', 11],
  ['التكاثر', 'At-Takathur', 'The Rivalry in world increase', 8],
  ['العصر', 'Al-Asr', 'The Declining Day', 3],
  ['الهمزة', 'Al-Humazah', 'The Traducer', 9],
  ['الفيل', 'Al-Fil', 'The Elephant', 5],
  ['قريش', 'Quraysh', 'Quraysh', 4],
  ['الماعون', "Al-Ma'un", 'The Small Kindnesses', 7],
  ['الكوثر', 'Al-Kawthar', 'The Abundance', 3],
  ['الكافرون', 'Al-Kafirun', 'The Disbelievers', 6],
  ['النصر', 'An-Nasr', 'The Divine Support', 3],
  ['المسد', 'Al-Masad', 'The Palm Fiber', 5],
  ['الإخلاص', 'Al-Ikhlas', 'The Sincerity', 4],
  ['الفلق', 'Al-Falaq', 'The Daybreak', 5],
  ['الناس', 'An-Nas', 'Mankind', 6],
];

export const SURAHS: readonly Surah[] = RAW.map(
  ([arabicName, transliteration, englishName, ayahCount], i) => ({
    number: i + 1,
    arabicName,
    transliteration,
    englishName,
    ayahCount,
    revelation: MEDINAN.has(i + 1) ? 'Medinan' : 'Meccan',
  }),
);

/** Total number of ayahs across the whole Qur'an (6236). */
export const TOTAL_AYAHS = SURAHS.reduce((n, s) => n + s.ayahCount, 0);

export function getSurah(number: number): Surah | undefined {
  return SURAHS[number - 1];
}

/**
 * Validates a memorization reference — a surah plus an inclusive ayah range —
 * against the real ayah counts. Returns a normalized range or throws a message
 * suitable for surfacing to the user.
 */
export function validateRef(
  surahNumber: number,
  ayahStart: number,
  ayahEnd: number,
): { surahNumber: number; ayahStart: number; ayahEnd: number } {
  const surah = getSurah(surahNumber);
  if (!surah) throw new Error('Unknown surah');
  if (
    !Number.isInteger(ayahStart) ||
    !Number.isInteger(ayahEnd) ||
    ayahStart < 1 ||
    ayahEnd < 1
  ) {
    throw new Error('Ayah numbers must be positive whole numbers');
  }
  if (ayahEnd > surah.ayahCount) {
    throw new Error(
      `${surah.transliteration} has ${surah.ayahCount} ayahs`,
    );
  }
  if (ayahStart > ayahEnd) {
    throw new Error('Start ayah must not be after the end ayah');
  }
  return { surahNumber, ayahStart, ayahEnd };
}
