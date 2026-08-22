# Livetich — Deployment (single VPS, Docker)

The cheapest production-capable setup: one Linux box running the whole stack in
Docker. Only Caddy is exposed to the internet; it terminates TLS (auto Let's
Encrypt) and reverse-proxies the web app and API. MySQL, Redis, and object
storage stay on the internal Docker network with data in named volumes.

```
                 ┌──────────── VPS ────────────┐
  Internet ──▶ Caddy :443 ─┬─▶ web  :3000 (Next.js standalone)
   (TLS)                    └─▶ api  :3000 (NestJS) ─┬─▶ mysql :3306
                                                     ├─▶ redis :6379
                                                     └─▶ storage volume
```

Good for the pilot and early production on **one** instance. Scaling past one API
instance later needs a Redis-backed throttle store and `y-redis` for the board
(both noted in the security roadmap) — not required here.

---

## 0. Quickstart — Hetzner + LiveKit Cloud + Cloudflare (chosen setup)

The pilot target: a Hetzner box for the app, **LiveKit Cloud** for video (so
Hetzner's EU location doesn't affect call quality), **Cloudflare** for DNS.
Total ≈ **€5/mo** + LiveKit Cloud free tier. If Hetzner's signup rejects your
card/ID (it can be strict from some regions), fall back to **Vultr Johannesburg**
— every step below is identical bar the provider console.

**a. Server.** Hetzner Cloud → new project → **CX22** (2 vCPU / 4 GB), image
**Ubuntu 24.04**, location **Nuremberg/Falkenstein**, add your SSH key. Then in
Hetzner **Cloud Firewall** allow inbound **22** (ideally only your IP), **80**,
**443** — nothing else (video is on LiveKit Cloud, so no UDP ports needed).

**b. LiveKit Cloud.** Create a project at cloud.livekit.io → copy the **URL**
(`wss://<you>.livekit.cloud`), **API key**, **API secret** → these become
`LIVEKIT_URL/KEY/SECRET` in step (e). Leave the compose `livekit` profile OFF.

**c. DNS (Cloudflare).** Add A records `app` and `api` → the server IP. Set both
to **DNS-only (grey cloud)** for now so Caddy can get Let's Encrypt certs via the
HTTP challenge. (You can switch to proxied/orange later with SSL mode
*Full (strict)*.)

**d. Install Docker + clone.**
```bash
ssh root@<server-ip>
curl -fsSL https://get.docker.com | sh
# 4 GB is enough, but add 2 GB swap so the web build can't OOM:
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
git clone <livetich-api-url> && git clone <livetich-web-url>   # side by side
cd livetich-api
```

**e. Configure.**
```bash
cp deploy/.env.prod.example deploy/.env.prod
nano deploy/.env.prod
```
Set: `APP_DOMAIN=app.yourdomain`, `API_DOMAIN=api.yourdomain`, `ACME_EMAIL`,
`NEXT_PUBLIC_API_URL=https://api.yourdomain`, `WEB_ORIGIN=https://app.yourdomain`,
`WEB_URL=https://app.yourdomain`, `CERT_VERIFY_BASE=https://api.yourdomain/certificates/verify`,
the three `LIVEKIT_*` from step (b), and generate the secrets:
`openssl rand -base64 48` → `JWT_SECRET`; `openssl rand -base64 24` →
`MYSQL_PASSWORD`/`MYSQL_ROOT_PASSWORD` (then make `DATABASE_URL` match).

**f. Launch.**
```bash
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --build
curl -fsS https://api.yourdomain/health        # → {"status":"ok","db":true,...}
```
Then create the first org (step §4 below), seed the plugin catalog, and set up
the nightly backup cron (§8). Done — see the sections below for detail on each.

---

## 1. Prerequisites

- A VPS: **2 vCPU / 4 GB RAM** is comfortable for the pilot (1 GB min; the web
  build is the heaviest step — build with ≥2 GB or swap). Ubuntu 22.04/24.04.
- Docker Engine + Compose plugin: `curl -fsSL https://get.docker.com | sh`
- DNS: two A records pointing at the server IP —
  `app.example.com` and `api.example.com`.
- Both repos cloned **side by side** on the server:
  ```bash
  git clone <livetich-api> && git clone <livetich-web>
  # → ./livetich-api  and  ./livetich-web  in the same parent dir
  ```

## 2. Configure

All commands run from the **livetich-api** repo root.

```bash
cp deploy/.env.prod.example deploy/.env.prod
# Fill in domains, then generate secrets:
openssl rand -base64 48   # → JWT_SECRET
openssl rand -base64 24   # → MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD
```
Set `DATABASE_URL` to match the `MYSQL_*` values (host stays `mysql`). Point
`LIVEKIT_*`, `RESEND_API_KEY`, and `ALOC_API_KEY` at real services (see §6, §7).

Open the firewall: **80, 443/tcp** (and if self-hosting LiveKit, **7880-7881/tcp
+ 50000-60000/udp**). Everything else stays internal.

## 3. Launch

```bash
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --build
```
The API container runs `prisma migrate deploy` on start, so the schema is created
/updated automatically. Watch it come up:
```bash
docker compose -f docker-compose.prod.yml logs -f api
curl -fsS https://api.example.com/health     # → {"status":"ok","db":true,...}
```
Then open `https://app.example.com`.

## 4. First organization & admin

New sign-ups are email-verification gated. Create the first org via the app's
company sign-up (`https://app.example.com/register-organization`, i.e. API
`POST /auth/register-organization`). To get the 6-digit code:
- **With Resend configured** → it's emailed.
- **Without** → it's written to the API log: `docker compose logs api | grep -i otp`.

The add-on catalog (Islamic Education, Test Prep, Code Instruction) ships **in
code** (`src/plugins/catalog.ts`) — there is nothing to seed. Each org turns
packs on from the **Add-ons** page after signing up. (`scripts/seed-catalog.cjs`
is a **dev-only demo seeder** — fake instructors and sample courses — and is not
shipped in the production image. Do not run it against a real instance.)

## 5. TLS

Automatic. Caddy obtains and renews Let's Encrypt certs for both domains on first
boot (needs 80/443 reachable and DNS resolving). Nothing to do beyond `ACME_EMAIL`.

## 6. LiveKit (live video)

Two options — set `LIVEKIT_URL/KEY/SECRET` in `.env.prod` either way:

- **LiveKit Cloud free tier (recommended, zero-ops):** create a project, paste the
  three values, leave the `livekit` profile **off**. It handles TURN/media relay —
  the hard part on a NAT'd single box.
- **Self-hosted (cheapest, more setup):** edit `deploy/livekit.yaml` keys to match
  your env, open the UDP/TCP ports above, then:
  ```bash
  docker compose --profile livekit --env-file deploy/.env.prod -f docker-compose.prod.yml up -d
  ```
  Set `LIVEKIT_URL=wss://api.example.com:7880` (or the server IP). Test a 2-person
  call before relying on it — media on small boxes behind NAT can be finicky.

## 7. Email

Wire **Resend**: set `RESEND_API_KEY` + `MAIL_FROM` (verify the sending domain in
Resend). Without it, verification/reset emails are only logged — fine for a smoke
test, not for real users.

## 8. Backups (do this before onboarding real users)

`deploy/backup.sh` dumps MySQL and tars the storage volume into `./backups/`.
Schedule it nightly via cron on the host:
```bash
crontab -e
# 2:30am daily
30 2 * * * cd /path/to/livetich-api && ./deploy/backup.sh >> ./backups/backup.log 2>&1
```
**Test the restore now, not during an incident:**
```bash
./deploy/restore.sh backups/db-<stamp>.sql.gz backups/storage-<stamp>.tar.gz
```
Copy backups off the box (another region/bucket) so a lost VPS ≠ lost data.

## 9. Monitoring

- **Health:** `GET /health` (checks DB, returns 503 when down). Compose already
  restarts unhealthy containers (`restart: unless-stopped`).
- **Uptime + alerts (cheapest):** run [Uptime Kuma] on the box or a free tier,
  polling `https://api.example.com/health` and `https://app.example.com`.
- **Errors:** wire Sentry (`@sentry/nestjs`, `@sentry/nextjs`, free tier) when you
  want stack traces — not included here to keep the image lean.

## 10. Updates & rollback

```bash
git -C ../livetich-web pull && git pull        # both repos
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --build
```
Migrations apply automatically on API start. **Rollback:** `git checkout <prev-tag>`
in both repos and re-run the command; restore the DB from a backup only if a
migration must be undone (Prisma has no auto down-migration).

## 11. Pre-launch security checklist

- [ ] `JWT_SECRET`, `MYSQL_*` are strong and unique (not the examples).
- [ ] `WEB_ORIGIN` set — the API refuses to boot in prod without it (locks CORS).
- [ ] `deploy/.env.prod` is **not** committed (it's gitignored).
- [ ] TLS green on both domains; `http://` redirects to `https://`.
- [ ] Nightly backup cron running **and** a restore rehearsed.
- [ ] Firewall: only 80/443 (+ LiveKit ports if self-hosting) open.
- [ ] Resend sending real email.

Still open before general availability (see the security roadmap): a formal
pentest, a saturation load-test, KYB for self-serve org signup, and the
minors'-data / privacy policy.

[Uptime Kuma]: https://github.com/louislam/uptime-kuma
