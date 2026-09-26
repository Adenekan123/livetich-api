-- A Tajweed mark becomes a list of parts.
--
-- It used to be one ayah and a contiguous range: a word span, or a letter span
-- inside a single word. That cannot express what a teacher actually marks — the
-- noon of one word and the sheen of a word in the next ayah — so the range is
-- replaced by the parts it always meant. Every stored range is expanded into
-- those parts BEFORE the old columns are dropped, so nothing is lost.

-- CreateTable
CREATE TABLE `TajweedAnnotationPart` (
    `id` VARCHAR(191) NOT NULL,
    `annotationId` VARCHAR(64) NOT NULL,
    `position` INTEGER NOT NULL,
    `surahNumber` INTEGER NOT NULL,
    `ayahNumber` INTEGER NOT NULL,
    `wordIndex` INTEGER NULL,
    `letterIndex` INTEGER NULL,

    INDEX `TajweedAnnotationPart_surahNumber_ayahNumber_idx`(`surahNumber`, `ayahNumber`),
    INDEX `TajweedAnnotationPart_annotationId_position_idx`(`annotationId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TajweedAnnotationPart` ADD CONSTRAINT `TajweedAnnotationPart_annotationId_fkey` FOREIGN KEY (`annotationId`) REFERENCES `TajweedAnnotation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a whole-ayah mark is one part with no word.
INSERT INTO `TajweedAnnotationPart` (`id`, `annotationId`, `position`, `surahNumber`, `ayahNumber`, `wordIndex`, `letterIndex`)
SELECT UUID(), `a`.`id`, 0, `a`.`surahNumber`, `a`.`ayahNumber`, NULL, NULL
FROM `TajweedAnnotation` `a`
WHERE `a`.`selection` = 'AYAH';

-- Backfill: a word range becomes one part per word in it. The longest ayah has
-- fewer than 256 words, so the generated series covers every stored index.
INSERT INTO `TajweedAnnotationPart` (`id`, `annotationId`, `position`, `surahNumber`, `ayahNumber`, `wordIndex`, `letterIndex`)
WITH RECURSIVE `seq` (`n`) AS (
    SELECT 0
    UNION ALL
    SELECT `n` + 1 FROM `seq` WHERE `n` < 255
)
SELECT UUID(), `a`.`id`, `s`.`n` - `a`.`wordStart`, `a`.`surahNumber`, `a`.`ayahNumber`, `s`.`n`, NULL
FROM `TajweedAnnotation` `a`
JOIN `seq` `s` ON `s`.`n` BETWEEN `a`.`wordStart` AND `a`.`wordEnd`
WHERE `a`.`selection` = 'WORD' AND `a`.`wordStart` IS NOT NULL AND `a`.`wordEnd` IS NOT NULL;

-- Backfill: a letter range becomes one part per letter. The old shape kept a
-- letter selection inside one word, so wordStart is that word.
INSERT INTO `TajweedAnnotationPart` (`id`, `annotationId`, `position`, `surahNumber`, `ayahNumber`, `wordIndex`, `letterIndex`)
WITH RECURSIVE `seq` (`n`) AS (
    SELECT 0
    UNION ALL
    SELECT `n` + 1 FROM `seq` WHERE `n` < 255
)
SELECT UUID(), `a`.`id`, `s`.`n` - `a`.`letterStart`, `a`.`surahNumber`, `a`.`ayahNumber`, `a`.`wordStart`, `s`.`n`
FROM `TajweedAnnotation` `a`
JOIN `seq` `s` ON `s`.`n` BETWEEN `a`.`letterStart` AND `a`.`letterEnd`
WHERE `a`.`selection` = 'LETTERS' AND `a`.`wordStart` IS NOT NULL AND `a`.`letterStart` IS NOT NULL AND `a`.`letterEnd` IS NOT NULL;

-- AlterTable: the ranges are now parts, and a mark can be kept for the course.
-- `rule` widens because a rule is addressed as "group.rule" (nun.ikhfa_haqiqi).
ALTER TABLE `TajweedAnnotation` DROP COLUMN `letterEnd`,
    DROP COLUMN `letterStart`,
    DROP COLUMN `selection`,
    DROP COLUMN `wordEnd`,
    DROP COLUMN `wordStart`,
    ADD COLUMN `kept` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `rule` VARCHAR(48) NULL;

-- CreateIndex
CREATE INDEX `TajweedAnnotation_courseId_kept_idx` ON `TajweedAnnotation`(`courseId`, `kept`);
