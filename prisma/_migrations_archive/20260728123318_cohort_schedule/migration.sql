-- Cohort program fields on Course (all nullable, additive).
-- Live sessions are still scheduled per occurrence; these describe the program.
ALTER TABLE `Course`
  ADD COLUMN `category` VARCHAR(191) NULL,
  ADD COLUMN `level` VARCHAR(191) NULL,
  ADD COLUMN `startDate` DATETIME(3) NULL,
  ADD COLUMN `durationWeeks` INTEGER NULL,
  ADD COLUMN `meetingDays` JSON NULL,
  ADD COLUMN `meetingTime` VARCHAR(191) NULL,
  ADD COLUMN `timezone` VARCHAR(191) NULL;
