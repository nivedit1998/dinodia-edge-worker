<!-- Architecture: Cloudflare edge-worker module README.md; handles ingress/routing or scheduled monitoring around the platform deployment targets. Keep Vercel/AWS selection and worker bindings aligned with the architecture map. -->
# dinodia-edge-worker

Cloudflare Worker for routing:
- `app.dinodiasmartliving.com/api/*`

This allows keeping one public base URL while choosing backend per request.

## Requirements
- `app.dinodiasmartliving.com` is **proxied** (orange cloud) in Cloudflare.
- Cloudflare SSL/TLS mode is **Full (strict)**.
- Cache rule bypass for `/api/*`.

## Variables
Defined in `wrangler.toml`:

```toml
AWS_API_ORIGIN = "https://api-origin.dinodiasmartliving.com"
VERCEL_APP_ORIGIN = "https://dinodia-platform.vercel.app"
DEFAULT_BACKEND = "vercel"
ENABLE_AWS_CANARY = "false"
CANARY_IPS = ""
CRON_TARGET_URL = "https://app.dinodiasmartliving.com/api/cron/monitoring-snapshot"
HUB_AVAILABILITY_CRON_TARGET_URL = "https://app.dinodiasmartliving.com/api/cron/hub-availability"
```

And define this secret once:

```bash
wrangler secret put CRON_SECRET
```

Behavior:
- If `ENABLE_AWS_CANARY != "true"`, all `/api/*` requests route to **Vercel**.
- If `ENABLE_AWS_CANARY == "true"`:
  - allowlisted `CANARY_IPS` route to **AWS**
  - everyone else follows `DEFAULT_BACKEND`
- Scheduled trigger (`0 */2 * * *`) calls `CRON_TARGET_URL` with `Authorization: Bearer $CRON_SECRET`.
- Scheduled trigger (`*/15 * * * *`) calls `HUB_AVAILABILITY_CRON_TARGET_URL` with `Authorization: Bearer $CRON_SECRET`.

## Operating Modes

### Mode A: Vercel-only (recommended default)
Use:
- `ENABLE_AWS_CANARY = "false"`
- `DEFAULT_BACKEND = "vercel"`
- `CANARY_IPS = ""`

Result:
- No request can route to AWS.

### Mode B: AWS canary (when AWS origin is healthy)
Use:
- `ENABLE_AWS_CANARY = "true"`
- `DEFAULT_BACKEND = "vercel"` (keep safe while canarying)
- `CANARY_IPS = "x.x.x.x,y.y.y.y"`

Result:
- Only listed public IPs route to AWS.

## Deploy
```bash
cd "Dinodia Smart Living/dinodia-edge-worker"
wrangler login
wrangler deploy
```

Then verify in Cloudflare dashboard:
- Worker route exists: `app.dinodiasmartliving.com/api/*`
- Worker Variables match expected production mode
- Worker Secret `CRON_SECRET` is set
- No stale dashboard var overrides

## Validation
```bash
curl -i https://app.dinodiasmartliving.com/api/health
curl -I https://app.dinodiasmartliving.com/api/auth/me
```

Expected (Vercel-only mode):
- No HTTP `530`
- No Cloudflare `1016` body
- `x-dinodia-api-backend: vercel`

## Scheduled Trigger Validation
```bash
wrangler dev --test-scheduled
# in another shell:
curl -i "http://127.0.0.1:8787/__scheduled?cron=0+*/2+*+*+*"

# production logs:
wrangler tail dinodia-api-router --format pretty
```

Expected:
- Scheduled invocation logs show `Snapshot request succeeded`
- Upstream cron endpoint returns HTTP 2xx

## Notes
- Worker preserves original host/proto headers for upstream auth/redirect consistency.
- Keep `AWS_API_ORIGIN` defined even in Vercel-only mode so AWS can be re-enabled later without structural changes.
