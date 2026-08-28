# Platform admin console

A cross-org operator console at **`/admin`** (web), gated to users with the
`isSuperAdmin` flag. It surfaces:

- **Overview** — orgs, users (by role + active/disabled), courses, live sessions,
  submissions, and AI spend/tokens (today + last 30 days).
- **Users** — every user across all orgs, with search/filter and actions:
  disable/enable, send reset link, force-verify email, change role,
  grant/revoke super-admin, and impersonate. Every action is audit-logged.
- **Audit log** — immutable trail of security/admin events, filterable.
- **AI usage** — token + estimated-cost breakdown by model, feature, and org,
  with a daily trend.

## Granting the first super-admin (bootstrap)

`isSuperAdmin` is deliberately **not** a role and can't be obtained through
signup — you set the first one manually, then that operator can grant others
from the Users page.

### Production (Docker) — SQL one-liner

The slim runner image doesn't carry the helper script, so set the flag directly
in MySQL. From the repo dir on the server:

```bash
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml exec mysql \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" livetich \
  -e "UPDATE User SET isSuperAdmin=1 WHERE email='"'"'you@example.com'"'"';"'
```

Replace `you@example.com`. To revoke, set `isSuperAdmin=0`.

> The existing session token still works after this, but the `/admin` link only
> appears after the flag is in the token — **sign out and back in once** to pick
> it up. (The API guard reads the flag live from the DB, so API access is
> immediate; only the web nav needs the fresh token.)

### Local / dev — helper script

```bash
pnpm admin:grant you@example.com          # grant
pnpm admin:grant you@example.com --revoke # revoke
```

Runs against `DATABASE_URL`.

## Impersonation

Impersonate issues a **30-minute** token that logs you in as the target user
(for support/debugging). It cannot target another super-admin or a disabled
account, requires a fresh step-up (see below), and every use is written to the
audit log — and emails the security alert address.

## Security hardening

Because a super-admin is a skeleton key for the whole platform, `/admin` has four
defenses on top of normal auth:

### 1. Edge IP allowlist (Caddy)
`/admin` (dashboard + API) is refused at the proxy for any IP not in
`ADMIN_ALLOW_IPS` — even a valid operator session can't reach it from elsewhere.
**Fail-closed:** unset, it defaults to `127.0.0.1/32` (localhost only), so admin
is unreachable until you set your IP.

Set it in `deploy/.env.prod` (space-separated IPs/CIDRs; include IPv6 if you have
one), then restart Caddy:
```bash
# find your public IP:
curl -4 ifconfig.co        # and: curl -6 ifconfig.co
```
```bash
# in deploy/.env.prod:
ADMIN_ALLOW_IPS="41.x.x.x/32 2c0f:xxxx::/48"
```
```bash
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d caddy
```
If your ISP gives you a dynamic IP, either use your provider's static-IP option or
allow your ISP's CIDR block (looser, but still far better than open).

### 2. Step-up re-authentication
Opening the console requires re-entering your password (a "step-up"), valid for
**30 minutes**. So a stolen session token alone is not enough — the attacker also
needs the password. The API enforces this on every `/admin` route, not just the UI.

### 3. Fresh re-auth for destructive actions
Impersonation and granting/revoking platform-admin or changing a role require the
step-up to be **under 5 minutes old**; otherwise you're prompted to confirm your
password again.

### 4. Security alerts
Granting platform-admin and starting an impersonation email `SECURITY_ALERT_EMAIL`
in real time (needs `RESEND_API_KEY`). Treat an alert you didn't cause as a
compromise.

Recommended next step (not built): add TOTP 2FA for operator accounts.
