-- Close the "unlimited by accident" hole on workspaces created before
-- storageQuotaBytes had a default.
--
-- The previous migration only altered the column, and MODIFY does not touch
-- existing rows, so every workspace that already existed kept its NULL — which
-- the API reads as "no ceiling". New workspaces get the default; these never
-- would have. NULL stays meaningful (an operator can still set it deliberately
-- for an institution plan), it just stops being what everyone starts with.
UPDATE `organization`
   SET `storageQuotaBytes` = 5368709120 -- 5 GB
 WHERE `storageQuotaBytes` IS NULL;
