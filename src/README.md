# PulseBoard — network / server / system monitor

Live infrastructure dashboard: system specs, filesystem access (read/write/edit/delete),
live RAM + GPU, app status per IP:port (Node, Python, system), Docker containers + logs,
network throughput, alerts. Demo feed runs instantly; add your own machines via collectors.

## Files
- `index.html` — dashboard shell (Perchance body)
- `src/styles.css`, `src/app.js` — dashboard UI + demo simulator + live polling
- `src/agent/node-collector.js` — dependency-free Node collector
- `src/agent/python-collector.py` — stdlib Python collector (+optional psutil)

## Run a collector (on each machine to monitor)
```bash
# node (no npm install needed)
node src/agent/node-collector.js --port 9100 --token SECRET --watch /srv,/etc/nginx,/var/log,/data

# python
python3 src/agent/python-collector.py --port 9100 --token SECRET --watch /srv,/etc,/var/log,/data
# optional richer stats: pip install psutil docker
```
Check: `curl -H "Authorization: Bearer SECRET" http://localhost:9100/api/summary`

Docker: give the collector access to the Docker socket/CLI (`docker ps` must work for that user).

GPUs: NVIDIA via `nvidia-smi`, AMD via `rocm-smi` (else GPU list is empty — Pi shows SoC).

Filesystem reads: plain watchers cannot see reads (OS limitation). Collectors report
write/edit/delete reliably + tail nginx/apache access logs for read traffic. For full
Linux read-auditing: `auditctl -w /srv -p r -k pulseboard`.

## Expose it to the dashboard
- Same machine: add host `127.0.0.1:9100` — may be blocked by mixed-content if dashboard is https.
- Reliable remote: `cloudflared tunnel --url http://localhost:9100` (or ngrok / Tailscale-serve),
  then add the `https://…` URL + token in PulseBoard → Agents → + add host.
- Proxy toggle (Agents tab): ON = fetch via superFetch proxy (fixes CORS, can't reach LAN);
  OFF = direct browser fetch (needs CORS + reachable https URL).
- Offline fallback: paste `/api/summary` JSON via "paste collector JSON".

## API (what collectors serve)
- `GET /api/summary` → full snapshot (see Setup tab schema)
- `GET /api/logs?container=NAME&tail=200` → docker/app logs
- `POST /api/containers/:id/restart` (Bearer token)

## Notes
- Hosts + watchlist persist in localStorage. Demo hosts are synthetic (3 nodes).
- Threshold alerts: RAM > 90%, GPU temp > 84°C, container exits → toast + Overview feed.
