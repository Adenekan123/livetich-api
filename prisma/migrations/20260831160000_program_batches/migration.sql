-- Program batches: a Course may be a *batch* (scheduled instance) of another
-- Course (the program). Additive + nullable, so existing rows stay programs.
ALTER TABLE `Course` ADD COLUMN `parentCourseId` VARCHAR(191) NULL;

CREATE INDEX `Course_parentCourseId_idx` ON `Course`(`parentCourseId`);

ALTER TABLE `Course` ADD CONSTRAINT `Course_parentCourseId_fkey`
  FOREIGN KEY (`parentCourseId`) REFERENCES `Course`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
