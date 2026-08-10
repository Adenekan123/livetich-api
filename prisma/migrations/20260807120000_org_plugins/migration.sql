-- CreateTable
CREATE TABLE `OrgPlugin` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `pluginKey` VARCHAR(191) NOT NULL,
    `enabledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrgPlugin_organizationId_idx`(`organizationId`),
    UNIQUE INDEX `OrgPlugin_organizationId_pluginKey_key`(`organizationId`, `pluginKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrgPlugin` ADD CONSTRAINT `OrgPlugin_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
