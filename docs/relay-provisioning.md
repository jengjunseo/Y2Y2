# Provisioning — Y2Y2 v0.4 Relay

The Relay path is optional. The v0.3-compatible loopback Local Engine requires none of these cloud resources.

Required for Home Engine Relay:

- Upstash Redis REST URL/token
- high-entropy `Y2Y2_RELAY_OWNER_SECRET`
- Vercel Private Blob connected to the project
- Vercel Workflow support in the deployment

Do not put secrets in this repository. See `.env.example` only for variable names.

Certification must distinguish a successful build from a configured live Relay. Without the resources above, `/api/relay?action=configured` must report Relay unavailable while Local Engine continues to work.
