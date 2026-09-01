-- Class preferences: org-level admin toggles + a per-course assessment flag +
-- a released flag on materialised quizzes + a reminder dedupe log. All additive.

-- Org toggles (default off / 30) so existing orgs keep today's behaviour.
ALTER TABLE `Organization`
  ADD COLUMN `evictOnInstructorLeave` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `micRequiresRaisedHand`  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `preClassReminder`       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `reminderLeadMinutes`    INTEGER NOT NULL DEFAULT 30;

-- Per-course: release the class-end quiz instantly (default = today's behaviour).
ALTER TABLE `Course`
  ADD COLUMN `instantClassAssessment` BOOLEAN NOT NULL DEFAULT true;

-- Materialised quiz: released (visible/gated) or held for manual release.
ALTER TABLE `Assessment`
  ADD COLUMN `released` BOOLEAN NOT NULL DEFAULT true;

-- Reminder dedupe: one row per (course, occurrence day) already emailed.
CREATE TABLE `SessionReminder` (
    `id`       VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `dateKey`  VARCHAR(191) NOT NULL,
    `sentAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SessionReminder_courseId_dateKey_key`(`courseId`, `dateKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SessionReminder` ADD CONSTRAINT `SessionReminder_courseId_fkey`
  FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
