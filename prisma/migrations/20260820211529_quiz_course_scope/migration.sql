-- AlterTable
ALTER TABLE `quiz` ADD COLUMN `courseId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Quiz_courseId_idx` ON `Quiz`(`courseId`);

-- AddForeignKey
ALTER TABLE `Quiz` ADD CONSTRAINT `Quiz_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
