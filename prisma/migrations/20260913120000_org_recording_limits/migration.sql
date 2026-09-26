-- AlterTable
ALTER TABLE `organization` ADD COLUMN `maxRecordingMinutes` INTEGER NULL DEFAULT 180,
    ADD COLUMN `recordingQuality` VARCHAR(191) NOT NULL DEFAULT 'balanced',
    ADD COLUMN `recordingRetentionDays` INTEGER NULL DEFAULT 365,
    MODIFY `storageQuotaBytes` BIGINT NULL DEFAULT 5368709120;
