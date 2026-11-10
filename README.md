# sysmon

Live infrastructure & system telemetry dashboard and VPS Docker agent.

## 🚀 Port Series Architecture

| Service | Port | Container Name | Description |
| :--- | :--- | :--- | :--- |
| **Frontend** | `11111` | `sysmon-frontend` | Nginx dashboard UI + reverse proxy |
| **Backend** | `22222` | `sysmon-backend` | Telemetry collector & API server |
| **MongoDB** | `33333` | `sysmon-mongodb` | Historical metric persistence & alerts |
| **VPS Agent**| `55555` | `sysmon-vps-agent`| Standalone VPS Docker & system collector |

---

## 🛠️ Main Stack Quick Start (Ports 11111, 22222, 33333)

```bash
# Clone the repository
git clone https://github.com/karthi4632a1810/sysmon.git
cd sysmon

# Start all services with Docker Compose
docker compose up -d --build
```

Access:
* **Dashboard:** http://localhost:11111
* **Collector API:** http://localhost:22222/api/summary
* **MongoDB:** mongodb://localhost:33333/sysmon

---

## 📡 VPS Agent Quick Start (Port 55555)

To monitor a separate VPS (e.g. `192.168.101.116:55555`):

```bash
# Clone the standalone VPS branch
git clone -b vps https://github.com/karthi4632a1810/sysmon.git sysmon-agent
cd sysmon-agent

# Run the agent container
docker compose up -d --build
```

Or run directly with Docker:
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

---

## 📊 VPS Endpoints (`http://YOUR-VPS-IP:55555`)
* `GET /api/summary`: Complete telemetry snapshot (RAM, CPU, Docker status, container list)
* `GET /api/docker`: Live container status with CPU % and RAM %
* `GET /api/logs?container=NAME&tail=200`: Real Docker logs
* `POST /api/containers/:id/restart`: Restart container
* `POST /api/containers/:id/stop`: Stop container
* `POST /api/containers/:id/start`: Start container

