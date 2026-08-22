-- AlterTable
ALTER TABLE `invite` ADD COLUMN `courseId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Invite_courseId_idx` ON `Invite`(`courseId`);

-- AddForeignKey
ALTER TABLE `Invite` ADD CONSTRAINT `Invite_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
