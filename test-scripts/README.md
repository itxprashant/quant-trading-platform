# Production feature tests

Black-box scripts that hit the deployed Quantstorm stack (`https://quantstorm-2026.site` by default). They check trader, admin, and New Eden challenge features, plus auth, matching, WebSocket fan-out, rate limits, and edge cases.

They **create isolated `E2E *` challenges**, never place orders on existing live events, and **end** those challenges when the run finishes. They do not reset or drop production tables.

## Run

```bash
node test-scripts/run.mjs
```

Requires Node 22+ (global `fetch` + `WebSocket`). No extra packages.

| Env | Default |
|-----|---------|
| `API_URL` | `https://quantstorm-2026.site` |
| `WS_URL` | `wss://quantstorm-2026.site` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin1234` |
| `TRADER_PASSWORD` | `trader1234` |
| `SKIP_CLEANUP=1` | leave e2e challenges live |

Suites live under `suites/` and run in order: public → auth → lifecycle → trading → realtime → admin → New Eden → edge.

The edge suite includes a go-live race: an order placed immediately after Start. The engine now resumes the command stream from `0-0` (cursor persisted in Redis) so that order should rest on the book. Happy-path trading still waits until a canary bid is actually there.
