-- Intake codes belong to a program, not to the whole workspace.
--
-- The previous constraint made `code` unique per organisation, so a school
-- running Frontend and Backend could not give both a "SEP26" intake — which is
-- the ordinary case, not an edge one. Scoping it to the parent program fixes
-- that while still keeping one program's intakes distinct from each other.
--
-- Program codes are deliberately NOT covered here: a program has no parent, and
-- MySQL treats NULLs as distinct in a unique index, so this constraint cannot
-- see them. That half is enforced in CoursesService, where a clear message can
-- be returned instead of a constraint violation.

DROP INDEX `Course_organizationId_code_key` ON `Course`;

CREATE UNIQUE INDEX `Course_organizationId_parentCourseId_code_key`
    ON `Course`(`organizationId`, `parentCourseId`, `code`);
