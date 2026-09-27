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

### 1. Edge IP allowlist (Caddy) — SSH tunnel only
`/admin` (dashboard + API) is refused at the proxy for any IP not in
`ADMIN_ALLOW_IPS` — even a valid operator session can't reach it from elsewhere.
**Fail-closed:** unset, it defaults to `127.0.0.1/32` (localhost only), so admin
is unreachable until you set it.

**Production allows only the SSH tunnel.** `ADMIN_ALLOW_IPS="172.18.0.1/32"` is
the compose network's gateway: a request that enters the server through an SSH
tunnel reaches Caddy from that address, while every request from the internet
keeps its real IP. So `/admin` is closed to the whole internet, and reaching it
takes the server's SSH key — no dependence on your home IP, which changes and is
often shared by many customers of the same ISP.

**Opening the console (Windows):** from this repo, run

```powershell
powershell -ExecutionPolicy Bypass -File deploy\admin-console.ps1
```

It opens the tunnel with `~/.ssh/livetich_admin` (`-Key` for another), starts
Edge/Chrome in a separate profile with `livetich.nekan.dev` and
`api.livetich.nekan.dev` routed through it, and closes the tunnel when you close
that window. Elsewhere, do the same by hand: `ssh -N -L 8443:localhost:443
root@<server>` and a Chromium browser started with
`--host-resolver-rules="MAP livetich.nekan.dev 127.0.0.1:8443, MAP api.livetich.nekan.dev 127.0.0.1:8443"`.

Check the gateway after recreating the network (`docker compose down` can give
it a new subnet — admin then just stays closed until this is updated):

```bash
docker network inspect livetich_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

> **Keep the server IPv4-only, or revisit this.** Docker's userland proxy
> forwards IPv6 connections to published ports from the same gateway address, so
> if the server gains a public IPv6 address and an AAAA record, IPv6 visitors
> would pass this check. Today it has neither.

**Alternative — allow your own IP** (weaker; breaks whenever your IP changes).
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
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --no-deps caddy
```
(`--no-deps` keeps the api and web containers running; the env file is theirs too.)
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
