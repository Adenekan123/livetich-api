-- Per-day meeting time overrides: a JSON map { "0".."6": "HH:mm" } on Course.
-- Nullable and additive — NULL means every meeting day uses the single general
-- `meetingTime` (today's behaviour), so existing programs are unaffected.
ALTER TABLE `Course`
  ADD COLUMN `meetingTimesByDay` JSON NULL;
