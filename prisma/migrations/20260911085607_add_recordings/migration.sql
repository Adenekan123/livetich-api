-- AlterTable
ALTER TABLE `organization` ADD COLUMN `storageQuotaBytes` BIGINT NULL;

-- CreateTable
CREATE TABLE `Recording` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `startedById` VARCHAR(191) NOT NULL,
    `status` ENUM('STARTING', 'RECORDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'STARTING',
    `egressId` VARCHAR(191) NULL,
    `storageKey` VARCHAR(191) NULL,
    `sizeBytes` BIGINT NULL,
    `durationSec` INTEGER NULL,
    `error` VARCHAR(191) NULL,
    `shareToken` VARCHAR(191) NULL,
    `shareExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readyAt` DATETIME(3) NULL,

    UNIQUE INDEX `Recording_egressId_key`(`egressId`),
    UNIQUE INDEX `Recording_shareToken_key`(`shareToken`),
    INDEX `Recording_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `Recording_sessionId_idx`(`sessionId`),
    INDEX `Recording_courseId_idx`(`courseId`),
    INDEX `Recording_startedById_idx`(`startedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `LiveSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_startedById_fkey` FOREIGN KEY (`startedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
