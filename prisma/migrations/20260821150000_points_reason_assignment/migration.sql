-- Add ASSIGNMENT_GRADED to the points reason enum (graded assignments award points).
ALTER TABLE `PointsLedger` MODIFY `reason` ENUM('QUIZ_CORRECT', 'BUZZER_WIN', 'PARTICIPATION', 'ASSIGNMENT_GRADED') NOT NULL;
