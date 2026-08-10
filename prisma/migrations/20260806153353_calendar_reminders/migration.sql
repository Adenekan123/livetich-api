-- AlterTable
ALTER TABLE `course` ADD COLUMN `scheduleUpdatedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `enrollment` ADD COLUMN `reminderAddedAt` DATETIME(3) NULL;
