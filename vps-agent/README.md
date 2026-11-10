# SysMon VPS Agent (Port 55555)

Lightweight, dependency-free Node.js telemetry and Docker monitor agent for your VPS.
Exposes real-time RAM, CPU, disk, network, Docker status, container stats, logs, and container controls.

## 🚀 Quick Run on VPS (Docker)

Run directly with Docker:
```bash
docker run -d \
  --name sysmon-vps-agent \
  --restart unless-stopped \
  -p 55555:55555 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /proc:/host/proc:ro \
  -v /sys:/host/sys:ro \
  sysmon-vps-agent
```

Or using Docker Compose:
```bash
docker compose up -d --build
```

---

## 📡 Endpoints

Once running, you can query it from your central PulseBoard dashboard or curl:

### 1. Full Telemetry Snapshot (Used by Dashboard)
```bash
curl http://YOUR-VPS-IP:55555/api/summary
```
Returns:
* Hostname, OS, kernel, arch, uptime
* Real RAM (total, used, free, usage %)
* Real CPU (usage %, per-core %, 1m load)
* Docker engine status (running, version, total, running, stopped)
* Every container status & metrics (CPU%, RAM used/limit/%, Net IO, Ports, State)

### 2. Docker & Container List Only
```bash
curl http://YOUR-VPS-IP:55555/api/docker
```

### 3. Container Logs
```bash
curl "http://YOUR-VPS-IP:55555/api/logs?container=NAME_OR_ID&tail=100"
```

### 4. Container Controls
```bash
# Restart container
curl -X POST http://YOUR-VPS-IP:55555/api/containers/CONTAINER_ID/restart

# Stop container
curl -X POST http://YOUR-VPS-IP:55555/api/containers/CONTAINER_ID/stop

# Start container
curl -X POST http://YOUR-VPS-IP:55555/api/containers/CONTAINER_ID/start
```

---

## 🔗 Connect to PulseBoard Frontend
Open your PulseBoard Dashboard (e.g. `http://localhost:11111`):
1. Navigate to **Agents** tab.
2. Click **+ Add Host**.
3. Name: `My VPS`
4. Base URL: `http://192.168.101.116:55555`
5. Click **Save Host**.

Your VPS CPU, RAM, Docker containers, and logs will immediately appear live!

