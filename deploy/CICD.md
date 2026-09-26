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
3. **deploy** — SSHes to the box (as root, with a CI-only key), logs in to GHCR
   with the job's short-lived token, pulls the image, restarts
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

Preferred: `git revert` the bad commit and push — CI deploys the fix.

To go back to an earlier image straight away, every build is also tagged with
its commit sha. The box holds no registry login (CI logs in only for the pull),
so log in first with a token that has `read:packages`:

```bash
cd /root/livetich-api
C="docker compose --env-file deploy/.env.prod -f docker-compose.prod.yml"
echo <token> | docker login ghcr.io -u Adenekan123 --password-stdin
docker pull ghcr.io/adenekan123/livetich-api:<good-sha>
docker tag  ghcr.io/adenekan123/livetich-api:<good-sha> ghcr.io/adenekan123/livetich-api:staging   # or :prod
$C up -d --no-build api        # same for web
docker logout ghcr.io
```

An image rollback does **not** undo a migration; restore from the pre-deploy
backup (`deploy/restore.sh`) if the schema change itself was the problem.

## What lives where

- **GitHub → Settings → Environments** (`staging`, `production`), in both repos:
  secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`; variable `APP_DIR` (parent dir of
  the checkouts); web also has variable `NEXT_PUBLIC_API_URL`.
- **Each box:** `deploy/.env.prod` sets `DEPLOY_TAG` (`staging` or `prod`), and
  root's `~/.ssh/authorized_keys` holds the `github-actions-deploy@livetich` key.
  To cut CI off, delete that line.

## Not automatic

- A change to `deploy/Caddyfile` is pulled onto the box by the next api deploy
  but Caddy isn't restarted — run `$C up -d caddy` (or `$C restart caddy`).
- New variables in `.env.prod` are added by hand on the box, then redeploy.
