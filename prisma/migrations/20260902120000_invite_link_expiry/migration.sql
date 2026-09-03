-- Org preference: default lifetime for new invite links, in days.
-- Nullable — NULL means links never expire (today's behaviour), so existing
-- orgs are unaffected. Applied at invite-creation time in createInvite.
ALTER TABLE `Organization`
  ADD COLUMN `inviteLinkExpiryDays` INTEGER NULL;
