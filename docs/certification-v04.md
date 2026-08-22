# Y2Y2 v0.4 Certification Matrix

| Claim | Required evidence before marking complete |
|---|---|
| v0.3 loopback preserved | existing Windows tests + packaged loopback smoke + actual local user flow when available |
| Home Engine registration persists | Windows registration + restart + outbound reconnect in configured Relay |
| automatic remote routing | browser without Local Engine routes to confirmed-online Home Engine |
| offline fail closed | Relay presence timeout/offline produces explicit unavailable UI and no enqueue |
| no cloud yt-dlp/ffmpeg | code inspection + deployed route behavior; media bytes upload directly via signed Blob PUT |
| one-hour cleanup | pure TTL unit test + configured live Workflow deletion observation |
| rights boundary preserved | README + ADR 0002 review |
| required tests green | npm, Windows pytest, Relay tests, CI builds |
