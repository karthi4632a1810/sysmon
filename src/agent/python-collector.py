#!/usr/bin/env python3
"""PulseBoard python collector — stdlib only (+optional psutil/docker for richer data).
Run:  python3 python-collector.py --port 9100 --token SECRET --watch /srv,/etc,/var/log,/data
Dashboard: PulseBoard → Agents → + add host → http(s)://THIS-IP:9100 (+ token).
Endpoints: GET /api/summary  GET /api/logs?container=NAME&tail=200  POST /api/containers/<id>/restart
Remote https: cloudflared tunnel --url http://localhost:9100
"""
import argparse, json, os, platform, re, socket, subprocess, threading, time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import psutil  # optional, richer cpu/mem/net if installed
    HAS_PSUTIL = True
except Exception:
    HAS_PSUTIL = False

ARGS = None
FS_EVENTS = deque(maxlen=300)
APP_LOGS = deque(maxlen=400)

def log_msg(src, msg, level="info"):
    APP_LOGS.appendleft({"t": int(time.time()*1000), "level": level, "src": src[:80], "msg": str(msg)[:500]})

def sh(cmd, timeout=4):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""

# ---------- fs watcher (poll-based, portable: write/edit/delete) ----------
WATCH_FILES = {}  # path -> mtime/size snapshot
def snapshot_tree():
    out = {}
    for base in ARGS.watch.split(","):
        base = base.strip()
        if not base or not os.path.isdir(base):
            continue
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"][:40]
            if len(out) > 4000:
                break
            for f in files[:300]:
                p = os.path.join(root, f)
                try:
                    st = os.stat(p)
                    out[p] = (int(st.st_mtime), st.st_size)
                except Exception:
                    pass
    return out

def watcher_loop():
    global WATCH_FILES
    WATCH_FILES = snapshot_tree()
    log_msg("collector", "watching: " + ARGS.watch)
    while True:
        time.sleep(3)
        try:
            cur = snapshot_tree()
            old_keys, new_keys = set(WATCH_FILES), set(cur)
            for p in list(new_keys - old_keys)[:30]:
                FS_EVENTS.appendleft({"t": int(time.time()*1000), "op": "write", "path": p, "proc": "", "size": cur[p][1]})
            for p in list(old_keys - new_keys)[:30]:
                FS_EVENTS.appendleft({"t": int(time.time()*1000), "op": "delete", "path": p, "proc": "", "size": 0})
            for p in list(new_keys & old_keys)[:60]:
                if cur[p] != WATCH_FILES[p]:
                    FS_EVENTS.appendleft({"t": int(time.time()*1000), "op": "edit", "path": p, "proc": "", "size": cur[p][1]})
            WATCH_FILES = cur
        except Exception as e:
            log_msg("collector", "watch error: %s" % e, "warn")

# NOTE on reads: portable watchers cannot see file READS (no inotify FAN_ACCESS here).
# For Linux read-auditing: auditctl -w /srv -p r -k pulseboard, then ausearch feeds FS_EVENTS.
# The dashboard labels these honestly as write/edit/delete + access-log reads.

# ---------- system ----------
def cpu_info():
    if HAS_PSUTIL:
        return {"usage": psutil.cpu_percent(interval=None), "perCore": psutil.cpu_percent(interval=None, percpu=True),
                "temp": cpu_temp(), "load1": os.getloadavg()[0] if hasattr(os, "getloadavg") else 0}
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()[1:]
        vals = list(map(int, parts))
        idle, total = vals[3], sum(vals)
        time.sleep(0.4)
        with open("/proc/stat") as f:
            parts2 = f.readline().split()[1:]
        vals2 = list(map(int, parts2))
        idle2, total2 = vals2[3], sum(vals2)
        usage = (1 - (idle2 - idle) / max(1, total2 - total)) * 100
        return {"usage": max(0, min(100, usage)), "perCore": [], "temp": cpu_temp(), "load1": os.getloadavg()[0] if hasattr(os, "getloadavg") else 0}
    except Exception:
        return {"usage": 0, "perCore": [], "temp": 0, "load1": 0}

def cpu_temp():
    for p in ("/sys/class/thermal/thermal_zone0/temp",):
        try:
            return int(open(p).read().strip()) / 1000
        except Exception:
            pass
    return 0

NET_LAST = {}
def net_info():
    if HAS_PSUTIL:
        c1 = psutil.net_io_counters(pernic=True)
        time.sleep(0.3)
        c2 = psutil.net_io_counters(pernic=True)
        ifaces, rx, tx = [], 0, 0
        for name in c2:
            if name == "lo":
                continue
            r = (c2[name].bytes_recv - c1[name].bytes_recv) / 0.3
            t = (c2[name].bytes_sent - c1[name].bytes_sent) / 0.3
            rx += max(0, r); tx += max(0, t)
            ip = nic_ip(name)
            ifaces.append({"name": name, "ip": ip, "rxBps": max(0, r), "txBps": max(0, t)})
        return {"rxBps": rx, "txBps": tx, "ifaces": ifaces}
    try:
        cur = {}
        for line in open("/proc/net/dev").read().splitlines()[2:]:
            m = re.match(r"\s*([^:]+):\s*(.+)", line)
            if m and m.group(1) != "lo":
                f = m.group(2).split()
                cur[m.group(1)] = (int(f[0]), int(f[8]))
        now = time.time()
        rx = tx = 0; ifaces = []
        for name, (r, s) in cur.items():
            if name in NET_LAST:
                dt = max(0.2, now - NET_LAST[name][2])
                rr, tt = (r - NET_LAST[name][0]) / dt, (s - NET_LAST[name][1]) / dt
                rx += max(0, rr); tx += max(0, tt)
                ifaces.append({"name": name, "ip": nic_ip(name), "rxBps": max(0, rr), "txBps": max(0, tt)})
            else:
                ifaces.append({"name": name, "ip": nic_ip(name), "rxBps": 0, "txBps": 0})
        for k, v in cur.items():
            NET_LAST[k] = (v[0], v[1], now)
        return {"rxBps": rx, "txBps": tx, "ifaces": ifaces}
    except Exception:
        return {"rxBps": 0, "txBps": 0, "ifaces": []}

def nic_ip(name):
    if HAS_PSUTIL:
        try:
            for a in psutil.net_if_addrs().get(name, []):
                if getattr(a.family, "name", "") == "AF_INET" and not a.address.startswith("127."):
                    return a.address
        except Exception:
            pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return ""

def gpu_info():
    out = []
    smi = sh("nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits")
    if smi.strip():
        for line in smi.strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            def num(x, d=0):
                try: return float(x)
                except Exception: return d
            out.append({"index": int(num(p[0])), "name": p[1] if len(p) > 1 else "NVIDIA GPU",
                        "util": num(p[2] if len(p) > 2 else 0), "memUsed": num(p[3] if len(p) > 3 else 0) * 1048576,
                        "memTotal": num(p[4] if len(p) > 4 else 0) * 1048576, "temp": num(p[5] if len(p) > 5 else 0),
                        "power": num(p[6] if len(p) > 6 else 0), "fan": num(p[7] if len(p) > 7 else 0)})
    return out

def disk_info():
    mounts = []
    df = sh("df -kP")
    for line in df.splitlines()[1:]:
        f = line.split()
        if len(f) < 6:
            continue
        try:
            total, used = int(f[1]) * 1024, int(f[2]) * 1024
            mounts.append({"mount": f[5], "dev": f[0], "total": total, "used": used, "pct": used / total * 100 if total else 0})
        except Exception:
            pass
    return mounts

def mem_info():
    if HAS_PSUTIL:
        m = psutil.virtual_memory()
        return {"total": m.total, "used": m.used, "pct": m.percent, "swapTotal": 0, "swapUsed": 0}
    try:
        kv = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            kv[k] = int(v.strip().split()[0]) * 1024
        total = kv.get("MemTotal", 1)
        free = kv.get("MemAvailable", kv.get("MemFree", 0))
        used = total - free
        return {"total": total, "used": used, "pct": used / total * 100, "swapTotal": kv.get("SwapTotal", 0), "swapUsed": kv.get("SwapTotal", 0) - kv.get("SwapFree", 0)}
    except Exception:
        return {"total": 0, "used": 0, "pct": 0, "swapTotal": 0, "swapUsed": 0}

# ---------- apps / ports ----------
def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def app_scan():
    apps = []
    ps = sh("ps -eo pid,pcpu,pmem,comm,args --no-headers | head -120")
    procs = []
    for line in ps.splitlines():
        m = re.match(r"\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)", line)
        if m:
            procs.append({"pid": m.group(1), "cpu": float(m.group(2) or 0), "mem": float(m.group(3) or 0), "comm": m.group(4), "args": m.group(5)})
    listen = {}
    ss = sh("ss -tlnp") or sh("netstat -tlnp")
    for line in ss.splitlines():
        mp = re.search(r":(\d+)\s", line)
        pid = (re.search(r"pid=(\d+)", line) or [None, None])[1]
        if mp:
            port = int(mp.group(1))
            if 0 < port < 65536:
                listen[port] = pid
    def guess(cmd, port):
        m2 = re.search(r"([A-Za-z0-9._-]+)\.(js|py)\b", cmd)
        if m2: return m2.group(1)
        if "nginx" in cmd: return "nginx"
        if "postgres" in cmd: return "postgres"
        return ("port-%d" % port) if port else (cmd.split(" ")[0].split("/")[-1][:40] or "proc")
    for port, pid in listen.items():
        owner = next((p for p in procs if p["pid"] == str(pid)), None)
        cmd = (owner["args"] or owner["comm"]) if owner else ""
        typ = "node" if re.search(r"node|bun|deno", cmd, re.I) else "python" if re.search(r"python", cmd, re.I) else "system"
        apps.append({"id": "app-%d" % port, "name": guess(cmd, port), "type": typ, "ip": local_ip(),
                     "port": port, "status": "running", "uptime": 0, "cpu": owner["cpu"] if owner else 0,
                     "mem": owner["mem"] if owner else 0, "latencyMs": None, "cmd": cmd[:160]})
    for p in procs:
        if len(apps) > 30: break
        blob = p["comm"] + " " + p["args"]
        if re.search(r"node|python|bun|deno", blob, re.I) and not any(a["cmd"] == (p["args"] or p["comm"]) for a in apps):
            apps.append({"id": "proc-" + p["pid"], "name": guess(p["args"] or p["comm"], 0),
                         "type": "python" if "python" in blob.lower() else "node", "ip": local_ip(), "port": 0,
                         "status": "running", "uptime": 0, "cpu": p["cpu"], "mem": p["mem"], "latencyMs": None, "cmd": (p["args"] or p["comm"])[:160]})
    # tcp probe
    for a in apps:
        if a["port"] > 0:
            t0 = time.time()
            try:
                s = socket.create_connection(("127.0.0.1", a["port"]), timeout=1.2)
                s[0].close()
                a["latencyMs"] = int((time.time() - t0) * 1000)
                a["open"] = True
            except Exception:
                a["open"] = False
    return apps

def parse_bytes(s):
    if not s: return 0
    m = re.match(r"\s*([\d.]+)\s*([KMGT]?i?B)?", str(s), re.I)
    if not m: return 0
    mult = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "KIB": 1024, "MIB": 1048576, "GIB": 1073741824, "TIB": 1099511627776}
    return float(m.group(1)) * mult.get((m.group(2) or "B").upper(), 1)

def docker_info():
    out = []
    ps = sh("docker ps -a --format '{{json .}}'")
    if not ps.strip():
        return out
    stats = {}
    for line in sh("docker stats --no-stream --format '{{json .}}'").splitlines():
        try:
            j = json.loads(line)
            stats[j.get("Name") or j.get("Container")] = j
        except Exception:
            pass
    for line in ps.splitlines():
        try:
            j = json.loads(line)
            s = stats.get(j.get("Names"), {})
            mu = str(s.get("MemUsage", "")).split("/")
            nio = str(s.get("NetIO", "")).split("/")
            out.append({"id": j.get("ID"), "name": j.get("Names"), "image": j.get("Image"),
                        "state": "running" if re.search(r"Up", j.get("Status", ""), re.I) else "paused" if re.search(r"Paused", j.get("Status", ""), re.I) else "exited",
                        "status": j.get("Status"), "cpu": float(str(s.get("CPUPerc", "0")).replace("%", "") or 0),
                        "memUsed": parse_bytes(mu[0] if len(mu) > 0 else ""), "memLimit": parse_bytes(mu[1] if len(mu) > 1 else ""),
                        "netRx": parse_bytes(nio[0] if len(nio) > 0 else ""), "netTx": parse_bytes(nio[1] if len(nio) > 1 else ""),
                        "ports": j.get("Ports", ""), "uptime": 0, "restartCount": 0})
        except Exception:
            pass
    return out

def build_summary():
    mem = mem_info()
    gpus = gpu_info()
    apps = app_scan()
    ports = [{"port": a["port"], "ip": a["ip"], "proto": "tcp", "service": a["name"], "open": a.get("open", True), "ms": a.get("latencyMs")} for a in apps if a["port"] > 0]
    ports.append({"port": 22, "ip": local_ip(), "proto": "tcp", "service": "ssh", "open": True, "ms": None})
    boot = psutil.boot_time() if HAS_PSUTIL else 0
    uptime = time.time() - boot if boot else 0
    cpu = cpu_info()
    return {
        "hostname": socket.gethostname(), "time": int(time.time()*1000), "uptime": uptime,
        "specs": {"os": "%s %s" % (platform.system(), platform.release()), "kernel": platform.release(), "arch": platform.machine(),
                  "cpuModel": platform.processor() or platform.machine(), "cpuCores": os.cpu_count() or 1,
                  "memTotal": mem["total"], "gpus": [{"name": g["name"], "vram": g["memTotal"]} for g in gpus],
                  "disks": [{"mount": d["mount"], "dev": d["dev"], "total": d["total"]} for d in disk_info()],
                  "nics": [{"name": k, "ip": v} for k, v in [("lan", local_ip())]]},
        "cpu": cpu, "mem": mem, "gpu": gpus,
        "disk": {"mounts": disk_info(), "readBps": 0, "writeBps": 0},
        "net": net_info(), "apps": apps, "containers": docker_info(),
        "fsEvents": list(FS_EVENTS)[:80], "logs": list(APP_LOGS)[:80], "ports": ports,
    }

class H(BaseHTTPRequestHandler):
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
    def authed(self):
        if not ARGS.token:
            return True
        return self.headers.get("Authorization") == "Bearer " + ARGS.token
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            body = b"<h3>PulseBoard python collector</h3><p>GET /api/summary</p>"
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        if not self.authed():
            return self.send_json({"error": "unauthorized"}, 401)
        if u.path == "/api/summary":
            return self.send_json(build_summary())
        if u.path == "/api/logs":
            q = parse_qs(u.query)
            tail = min(500, int((q.get("tail") or ["200"])[0]))
            c = (q.get("container") or [None])[0]
            if c:
                out = sh("docker logs --tail %d %s 2>&1 | tail -%d" % (tail, re.sub(r'[^a-zA-Z0-9_.-]', '', c), tail), timeout=8)
                lines = [{"t": int(time.time()*1000), "level": "error" if re.search(r"err|fail|exception", l, re.I) else "info", "src": c, "msg": l[:500]} for l in out.splitlines() if l.strip()]
                return self.send_json({"lines": lines[-tail:]})
            return self.send_json({"lines": list(APP_LOGS)[:tail]})
        return self.send_json({"error": "not found"}, 404)
    def do_POST(self):
        u = urlparse(self.path)
        if not self.authed():
            return self.send_json({"error": "unauthorized"}, 401)
        m = re.match(r"^/api/containers/(.+)/restart$", u.path)
        if m:
            cid = re.sub(r"[^a-zA-Z0-9_.-]", "", m.group(1))
            out = sh("docker restart %s 2>&1" % cid, timeout=15)
            return self.send_json({"ok": True, "out": out[:1000]})
        return self.send_json({"error": "not found"}, 404)
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="9100")
    ap.add_argument("--token", default="")
    ap.add_argument("--watch", default="/srv,/etc,/var/log,/data")
    ap.add_argument("--host", default="0.0.0.0")
    ARGS = ap.parse_args()
    threading.Thread(target=watcher_loop, daemon=True).start()
    log_msg("collector", "python collector starting (psutil=%s)" % HAS_PSUTIL)
    print("PulseBoard python collector on http://%s:%s" % (ARGS.host, ARGS.port))
    print("  curl %shttp://localhost:%s/api/summary" % ("-H 'Authorization: Bearer %s' " % ARGS.token if ARGS.token else "", ARGS.port))
    if not ARGS.token:
        print("  WARNING: no --token set. Anyone on your network can read stats.")
    HTTPServer((ARGS.host, int(ARGS.port)), H).serve_forever()
