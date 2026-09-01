-- Coding task kind: LIVE (runs in a live session) vs ASSIGNMENT (homework for
-- the next class). Additive: a new column with a default; no existing data lost.
ALTER TABLE `CodingAssignment`
    ADD COLUMN `kind` ENUM('LIVE', 'ASSIGNMENT') NOT NULL DEFAULT 'ASSIGNMENT';
