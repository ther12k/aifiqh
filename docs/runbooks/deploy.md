# Runbook — production deploy (halotec-hermes)

Production runs on `halotec-hermes` under `/home/rizky/apps/aifiqh` as a
Docker Compose stack (`docker-compose.yml` +
`docker-compose.halotec.yml`): one unified `app` container (API + web
bundle) plus db / minio / oidc sidecars. The compose overrides keep the
sidecars unpublished — the app is reached through the shared reverse
proxy, not a host port.

## Standard app redeploy

1. `git fetch origin` on the host; confirm the target commit is green CI
   on `origin/main`.
2. `git checkout <commit>` (detached HEAD is the normal state here).
3. Build only the app image:
   `docker compose -f docker-compose.yml -f docker-compose.halotec.yml build app`
4. Recreate ONLY the app container:
   `docker compose -f docker-compose.yml -f docker-compose.halotec.yml up -d --no-deps app`

   **Never drop `--no-deps` on a redeploy.** A plain `up -d` resolves the
   whole dependency graph and will try to pull/recreate stateful sidecars
   (e.g. an init image that exists only locally) — failing the redeploy or
   churning services that did not change. Dependency lifecycle belongs to
   deliberate maintenance, not to an app rollout.
5. Verify from inside the container (no published host port):
   - `/healthz` returns 200;
   - the served `index.html` references the freshly built bundle hash;
   - authenticated endpoints answer 401 for anonymous requests (auth
     gate live), not 404/000.

## Notes

- Verify CI is green BEFORE deploying; never deploy a commit whose run is
  still `in_progress`.
- The host checkout tracks `origin/main` by content, not by branch: after
  fetching, deploy the exact commit hash that CI validated.
- Docs-only commits may legitimately sit ahead of the deployed commit —
  drift is only a concern for anything under `apps/` or `packages/`.
