-- Instructor-set points per buzzer question (first correct answerer earns them).
ALTER TABLE `QuizQuestion` ADD COLUMN `points` INT NOT NULL DEFAULT 25;
