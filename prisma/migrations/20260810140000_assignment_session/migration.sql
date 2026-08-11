-- AlterTable
ALTER TABLE `Assignment` ADD COLUMN `sessionId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Assignment_sessionId_idx` ON `Assignment`(`sessionId`);

-- AddForeignKey
ALTER TABLE `Assignment` ADD CONSTRAINT `Assignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `LiveSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
