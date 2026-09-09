-- CreateTable
CREATE TABLE `Membership` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `role` ENUM('INSTRUCTOR', 'STUDENT', 'ORG_ADMIN') NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Membership_userId_idx`(`userId`),
    INDEX `Membership_organizationId_idx`(`organizationId`),
    UNIQUE INDEX `Membership_userId_organizationId_key`(`userId`, `organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Membership` ADD CONSTRAINT `Membership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Membership` ADD CONSTRAINT `Membership_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: seed one membership per existing user from their legacy
-- organizationId / role / status, so no one loses access when reads move to
-- Membership in later phases. Users with no organizationId (none today) are
-- skipped. The unique(userId, organizationId) key makes a re-run a no-op.
INSERT INTO `Membership` (`id`, `userId`, `organizationId`, `role`, `status`, `createdAt`, `updatedAt`)
SELECT UUID(), `id`, `organizationId`, `role`, `status`, `createdAt`, NOW(3)
FROM `User`
WHERE `organizationId` IS NOT NULL;
