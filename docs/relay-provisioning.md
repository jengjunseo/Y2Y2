# Provisioning — Y2Y2 v0.4 Relay

The Relay path is optional. The v0.3-compatible loopback Local Engine requires none of these cloud resources.

Required for Home Engine Relay:

- Upstash Redis REST URL/token
- high-entropy `Y2Y2_RELAY_OWNER_SECRET` (minimum 32 characters)
- Vercel Private Blob connected to the project, providing `BLOB_READ_WRITE_TOKEN`
- Vercel Workflow support in the deployment

Relay is considered configured only when Redis, owner secret, and the Private Blob credential are all present. A partial setup must fail closed instead of accepting remote jobs that cannot produce a retrievable TTL-bound artifact.

The Windows Home Engine uses a 20-second idle poll and a 5-second active-job poll. Presence expires after 50 seconds. The slower idle interval is intentional: one idle poll currently costs at least three Redis operations (device auth, presence refresh, claim), so 20 seconds keeps an always-on 30-day idle baseline below 500,000 Redis commands before active-job traffic.

Do not put secrets in this repository. See `.env.example` only for variable names.

Certification must distinguish a successful build from a configured live Relay. Without the resources above, `/api/relay?action=configured` must report Relay unavailable while Local Engine continues to work.
