# Staging deployment runbook

Staging is a **separate Vultr instance** that mirrors production but tracks the
`staging` git branch instead of `main`. Its purpose: prove a change works with a
real build, real migrations, and real TLS **before** it ever reaches live users.

- **Live (prod):** `main` branch → the 1 GB box → `livetich.nekan.dev`
- **Staging:** `staging` branch → this box → `staging.livetich.nekan.dev`

Release flow: land changes on `staging` → verify here → merge `staging → main` →
deploy prod. Nothing reaches `main` until it has run on staging.

---

## One-time setup

### 1. Provision the instance
- Vultr → deploy a new **Cloud Compute** instance. **2 GB RAM** recommended
  (staging builds Next.js + Nest in Docker; 1 GB is tight — see prod build notes
  in `DEPLOY.md`). Same region (Johannesburg) is fine.
- Note its public IPv4.

### 2. DNS (at your registrar, for nekan.dev)
Add two **A records** pointing at the staging IP:

| Type | Name                  | Value              |
|------|-----------------------|--------------------|
| A    | `staging`             | `<staging-ip>`     |
| A    | `api-staging`         | `<staging-ip>`     |

Caddy gets Let's Encrypt certs automatically once these resolve.

### 3. Install Docker + clone both repos (on the staging box)
```bash
# --- Docker (Ubuntu) ---
ssh root@<staging-ip>          # from your machine
apt update
curl -fsSL https://get.docker.com | sh    # Engine + CLI + compose v2 plugin

# Verify both are present, then confirm the daemon is up.
docker --version
docker compose version
systemctl status docker --no-pager        # want: active (running); q to quit
# If not running: systemctl enable --now docker
# (Running as root, so no usermod/docker-group step is needed.)

# Both repos must sit side by side (compose builds ../livetich-web).
git clone https://github.com/Adenekan123/livetich-api.git
git clone https://github.com/Adenekan123/livetich-web.git

# Track the staging branch in BOTH.
cd livetich-api && git checkout staging && cd ..
cd livetich-web && git checkout staging && cd ..
```

### 4. Configure secrets (on the staging box)
```bash
cd livetich-api
# Target name is .env.prod (docker-compose.prod.yml has `env_file: deploy/.env.prod`
# baked in). Staging differs by BRANCH + the values inside, not the filename.
cp deploy/.env.staging.example deploy/.env.prod
# Edit deploy/.env.prod: set ACME_EMAIL, generate FRESH secrets
#   (openssl rand -base64 48) for JWT_SECRET + MYSQL passwords,
#   add a low-quota GEMINI_API_KEY, and your LiveKit staging keys.
# NEVER reuse production secrets. NEVER commit this file.
```

### 5. Bring it up
```bash
cd livetich-api
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --build
```

Watch it come healthy:
```bash
docker compose --env-file deploy/.env.staging -f docker-compose.prod.yml ps
docker compose --env-file deploy/.env.staging -f docker-compose.prod.yml logs -f api
```

Then open `https://staging.livetich.nekan.dev` and register a fresh org through
the normal signup flow (staging starts with an empty DB — use throwaway data,
never real user data).

---

## Deploying an update to staging

From your machine, push the branch; on the box, pull + rebuild.

```bash
# local
git push origin staging

# on the staging box (in BOTH repos if both changed)
cd livetich-api && git pull
cd ../livetich-web && git pull
cd ../livetich-api
docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml up -d --build
```

Prisma migrations run on API start (`migrate deploy`). If a migration needs a
manual step, see `DEPLOY.md`.

---

## Promoting staging → production

Once a change is verified on staging:

```bash
# local
git checkout main
git merge --no-ff staging
git push origin main
```

Then deploy prod as usual (`DEPLOY.md`). Keep `staging` ahead of or equal to
`main`; never hotfix `main` without back-merging into `staging`.

---

## Notes
- Staging and prod share **no** data, secrets, or volumes — they are different
  machines. A wipe/reseed on staging is safe and never touches live users.
- Emails: leave `RESEND_API_KEY` blank on staging so verification/reset mails are
  logged, not delivered to real inboxes.
- Cost control: use a **low-quota** `GEMINI_API_KEY` so staging AI runs can't
  drain the production budget.
