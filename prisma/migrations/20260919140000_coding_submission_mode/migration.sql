-- How a coding program's students hand work in.
--
-- Until now "is this a coding program" was inferred from the presence of a
-- CodingProgramGitConfig row. That row requires a GitHub connection, so the
-- inference also forced GitHub setup on programs that only ever wanted a .zip
-- upload — and gave a student on such a program the message "your instructor
-- needs to finish connecting it", which was simply untrue.
--
-- Nullable on purpose: NULL means "not a coding program", which is what almost
-- every course in the table is.
ALTER TABLE `Course`
  ADD COLUMN `codingSubmissionMode` ENUM('GIT', 'UPLOAD') NULL;

-- Backfill: every program that already has git config was, by definition, a
-- git-backed coding program. Nothing else is touched, so no course silently
-- becomes a coding program because of this migration.
UPDATE `Course` c
  JOIN `CodingProgramGitConfig` g ON g.`courseId` = c.`id`
  SET c.`codingSubmissionMode` = 'GIT';
