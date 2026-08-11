-- CreateTable
CREATE TABLE `HifzTarget` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `surahNumber` INTEGER NOT NULL,
    `ayahStart` INTEGER NOT NULL,
    `ayahEnd` INTEGER NOT NULL,
    `dueAt` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HifzTarget_courseId_idx`(`courseId`),
    INDEX `HifzTarget_studentId_idx`(`studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HifzEntry` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `surahNumber` INTEGER NOT NULL,
    `ayahStart` INTEGER NOT NULL,
    `ayahEnd` INTEGER NOT NULL,
    `kind` ENUM('NEW_HIFZ', 'REVISION') NOT NULL,
    `rating` INTEGER NULL,
    `tajweed` TEXT NULL,
    `notes` TEXT NULL,
    `recordedById` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HifzEntry_courseId_studentId_idx`(`courseId`, `studentId`),
    INDEX `HifzEntry_studentId_idx`(`studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HifzTarget` ADD CONSTRAINT `HifzTarget_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HifzTarget` ADD CONSTRAINT `HifzTarget_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HifzTarget` ADD CONSTRAINT `HifzTarget_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HifzEntry` ADD CONSTRAINT `HifzEntry_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HifzEntry` ADD CONSTRAINT `HifzEntry_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HifzEntry` ADD CONSTRAINT `HifzEntry_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
