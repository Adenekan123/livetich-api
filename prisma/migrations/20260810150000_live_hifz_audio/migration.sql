-- AlterTable
ALTER TABLE `HifzEntry` ADD COLUMN `sessionId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Submission` ADD COLUMN `fileMimeType` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `HifzEntry_sessionId_idx` ON `HifzEntry`(`sessionId`);

-- AddForeignKey
ALTER TABLE `HifzEntry` ADD CONSTRAINT `HifzEntry_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `LiveSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
