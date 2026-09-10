# infra

Postgres archive for the Dev HUD. See [`../docs/plans/dev-hud.md`](../docs/plans/dev-hud.md) §1.1.

**This is the archive, not the hot store.** The shim reads SQLite; a nightly one-directional export
pushes here. Postgres being down must never affect the glasses.

## Running

```bash
cd infra
docker compose up -d          # password comes from infra/.env
docker compose logs -f postgres
docker compose down           # add -v to also drop the data volume
```

Container `devhud-postgres`, image `postgres:17-alpine`, data in the named volume
`infra_devhud-pgdata` — it survives `down` unless you pass `-v`.

## Connecting

**From this machine (Mac Mini):**

```bash
docker exec -it devhud-postgres psql -U devhud -d devhud
```

**From the MacBook, over the tailnet:**

```bash
psql "postgresql://devhud@ais-mac-mini.tail7ed4e6.ts.net:5432/devhud"
```

Password is in `infra/.env` (chmod 600, gitignored).

## Network posture

Postgres publishes to `127.0.0.1:5432` only — never the LAN. Tailnet access goes through:

```bash
tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432
tailscale serve --tcp=5432 off      # to remove
```

Reachable only by devices on your tailnet, and the link is WireGuard-encrypted end to end.
It is **not** Funnel — nothing is exposed to the public internet. Keep it that way.
