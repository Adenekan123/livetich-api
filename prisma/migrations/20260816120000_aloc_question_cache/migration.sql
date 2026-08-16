-- CreateTable
CREATE TABLE `AlocQuestionCache` (
    `id` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `examType` VARCHAR(191) NOT NULL,
    `year` INTEGER NULL,
    `body` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `correctIndex` INTEGER NOT NULL,
    `topic` VARCHAR(191) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AlocQuestionCache_subject_examType_year_idx`(`subject`, `examType`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
