-- Specialized classroom tools/plugins enabled per program (Course).
-- Stored as a JSON array of string keys, e.g. ["code-instruction", "maths-sciences"].
ALTER TABLE `Course` ADD COLUMN `pluginKeys` JSON NULL;
