# CI/CD — how deploys work

Deploys run from GitHub Actions; nobody needs to SSH in to ship.

| Push to   | Goes to            | Image tag  |
|-----------|--------------------|------------|
| `staging` | staging box        | `:staging` |
| `main`    | production box     | `:prod`    |

Each repo (`livetich-api`, `livetich-web`) has `.github/workflows/deploy.yml`:

1. **test** (api only) — `pnpm test` + `pnpm build`. Web's gate is its Docker
   build, since `next build` type-checks.
2. **build** — builds the Docker image and pushes it to GHCR as
   `ghcr.io/adenekan123/livetich-{api,web}:{staging|prod}` and `:<commit-sha>`.
3. **deploy** — SSHes to the box as the `deploy` user, pulls the image, restarts
   that one service, and waits for its healthcheck. A failing healthcheck fails
   the job (red X in the Actions tab). Production takes a `deploy/backup.sh`
   backup first (api deploys only).

The API still runs `prisma migrate deploy` on container start.

## Releasing

```bash
git push origin staging            # → staging, check it there
git checkout main && git merge --no-ff staging && git push origin main   # → live
```

Re-run a deploy without a new commit: Actions tab → **deploy** → *Run workflow*.

## Rolling back

Every build is also tagged with its commit sha. On the box (as `deploy`):

```bash
cd ~/livetich-api
C="docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml"
docker pull ghcr.io/adenekan123/livetich-api:<good-sha>
docker tag  ghcr.io/adenekan123/livetich-api:<good-sha> ghcr.io/adenekan123/livetich-api:prod
$C up -d --no-build api        # same for web
```

Or `git revert` the bad commit and push — that deploys the fix through CI.
An image rollback does **not** undo a migration; restore from the pre-deploy
backup (`deploy/restore.sh`) if the schema change itself was the problem.

## What lives where

- **GitHub → Settings → Environments** (`staging`, `production`), in both repos:
  secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`; variable `APP_DIR` (parent dir of
  the checkouts); web also has variable `NEXT_PUBLIC_API_URL`.
- **Each box:** `deploy/.env.prod` sets `DEPLOY_TAG` (`staging` or `prod`), and
  the `deploy` user is logged in to `ghcr.io` with a read-only (`read:packages`)
  token.

## Not automatic

- A change to `deploy/Caddyfile` is pulled onto the box by the next api deploy
  but Caddy isn't restarted — run `$C up -d caddy` (or `$C restart caddy`).
- New variables in `.env.prod` are added by hand on the box, then redeploy.
