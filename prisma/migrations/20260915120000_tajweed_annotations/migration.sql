-- CreateTable
CREATE TABLE `TajweedAnnotation` (
    `id` VARCHAR(64) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `sectionId` VARCHAR(191) NULL,
    `sessionId` VARCHAR(191) NULL,
    `mode` ENUM('LESSON', 'STUDENT_CORRECTION') NOT NULL,
    `studentId` VARCHAR(191) NULL,
    `hifzEntryId` VARCHAR(191) NULL,
    `surahNumber` INTEGER NOT NULL,
    `ayahNumber` INTEGER NOT NULL,
    `selection` ENUM('AYAH', 'WORD', 'LETTERS') NOT NULL,
    `wordStart` INTEGER NULL,
    `wordEnd` INTEGER NULL,
    `letterStart` INTEGER NULL,
    `letterEnd` INTEGER NULL,
    `rule` VARCHAR(32) NULL,
    `customLabel` VARCHAR(60) NULL,
    `style` ENUM('HIGHLIGHT', 'UNDERLINE') NOT NULL DEFAULT 'HIGHLIGHT',
    `color` VARCHAR(7) NULL,
    `note` TEXT NULL,
    `outcome` ENUM('CORRECT', 'REPEAT', 'TAJWEED_ISSUE', 'PRONUNCIATION', 'NOTE') NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdById` VARCHAR(191) NOT NULL,
    `updatedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TajweedAnnotation_courseId_sectionId_idx`(`courseId`, `sectionId`),
    INDEX `TajweedAnnotation_courseId_studentId_idx`(`courseId`, `studentId`),
    INDEX `TajweedAnnotation_sessionId_idx`(`sessionId`),
    INDEX `TajweedAnnotation_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TajweedAnnotationRevision` (
    `id` VARCHAR(191) NOT NULL,
    `annotationId` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `change` ENUM('CREATED', 'UPDATED', 'DELETED') NOT NULL,
    `snapshot` JSON NOT NULL,
    `changedById` VARCHAR(191) NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TajweedAnnotationRevision_annotationId_idx`(`annotationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_sectionId_fkey` FOREIGN KEY (`sectionId`) REFERENCES `Section`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `LiveSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_hifzEntryId_fkey` FOREIGN KEY (`hifzEntryId`) REFERENCES `HifzEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TajweedAnnotation` ADD CONSTRAINT `TajweedAnnotation_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

