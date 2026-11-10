#!/usr/bin/env node
/* PulseBoard node collector — dependency-free.
   Run: node node-collector.js --port 9100 --token SECRET --watch /srv,/etc/nginx,/var/log,/data
   Then open PulseBoard → Agents → + add host → http://THIS-IP:9100 (+ token).
   Exposes (CORS *):  GET /api/summary   GET /api/logs?container=NAME&tail=200
                       POST /api/containers/:id/restart
   For remote https: cloudflared tunnel --url http://localhost:9100
*/
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const net = require("net");
const db = require("./db");

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  const m = a.match(/^--([^=]+)(=(.*))?$/);
  if (m) args[m[1]] = m[3] !== undefined ? m[3] : (arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1");
});
const PORT = parseInt(process.env.PORT || args.port || "9100", 10);
const TOKEN = args.token || "";
const WATCH = String(args.watch || "/srv,/etc,/var/log,/data").split(",").map(s => s.trim()).filter(Boolean);
const HOST = args.host || "0.0.0.0";
const ROOT_DIR = path.resolve(__dirname, "../../");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(pathname, res) {
  let reqPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safePath);

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  return false;
}

function sh(cmd, timeout = 4000) {
  try { return cp.execSync(cmd, { timeout, stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return ""; }
}
function num(n, d = 0) { n = Number(n); return isFinite(n) ? n : d; }

// ---- ring buffers ----
const fsEvents = []; // {t,op,path,proc,size}
const appLogs = [];  // {t,level,src,msg}
function pushEv(e) { fsEvents.unshift({ t: Date.now(), ...e }); if (fsEvents.length > 300) fsEvents.length = 300; }
function logMsg(src, msg, level = "info") { appLogs.unshift({ t: Date.now(), level, src, msg: String(msg).slice(0, 500) }); if (appLogs.length > 400) appLogs.length = 400; }

// ---- file watcher (write/edit/delete; reads noted below) ----
function watchTree(dir) {
  let st; try { st = fs.statSync(dir); } catch { return; }
  if (!st.isDirectory()) return;
  try {
    const w = fs.watch(dir, { persistent: false }, (ev, file) => {
      const p = path.join(dir, file || "");
      let op = "edit", size = 0;
      if (ev === "rename") { try { const s = fs.statSync(p); size = s.isDirectory() ? 0 : s.size; op = "write"; watchTree(p); } catch { op = "delete"; } }
      else { try { size = fs.statSync(p).size; op = "edit"; } catch { op = "delete"; } }
      pushEv({ op, path: p, proc: guessProc(p), size });
    });
    w.on("error", () => {});
  } catch {}
  // recurse one level now (deep trees: best-effort, cap 60 dirs)
  try {
    for (const f of fs.readdirSync(dir).slice(0, 200)) {
      if (watchCount.count > 60) break;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).isDirectory() && !f.startsWith(".") && f !== "node_modules") { watchCount.count++; watchTree(p); } } catch {}
    }
  } catch {}
}
const watchCount = { count: 0 };
function guessProc(p) {
  // cheap attribution: which recent process touches this path (lsof, best effort)
  const out = sh(`lsof -Fpcn "${p.replace(/"/g, "")}" 2>/dev/null | head -20`);
  const m = out.match(/c([^\n]+)/);
  return m ? m[1].trim() : "";
}
WATCH.forEach(watchTree);
logMsg("collector", "watching: " + WATCH.join(", "));
// NOTE on reads: plain inotify/fs.watch cannot see file READS. For read auditing on
// Linux run e.g.: auditctl -w /srv -p r -k pulseboard  (then ausearch feeds here).
// The collector tails common access logs so dashboard still shows read traffic:
["/var/log/nginx/access.log", "/var/log/apache2/access.log"].forEach(f => tailFile(f, "read"));
function tailFile(f, op) {
  if (!fs.existsSync(f)) return;
  try {
    const proc = cp.spawn("tail", ["-F", "-n", "0", f]);
    proc.stdout.on("data", d => {
      const lines = d.toString().split("\n").filter(Boolean).slice(-5);
      lines.forEach(ln => pushEv({ op, path: f, proc: "tail-access", size: ln.length }));
    });
    proc.stderr.on("data", () => {});
  } catch {}
}

// ---- cpu sampler ----
let lastCpu = null;
function cpuSample() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  const per = cpus.map(c => {
    const t = c.times; const tt = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total: tt };
  });
  cpus.forEach(c => { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; });
  let usage = 0, perCore = per.map(() => 0);
  if (lastCpu) {
    const dIdle = idle - lastCpu.idle, dTotal = total - lastCpu.total;
    usage = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    perCore = per.map((p, i) => {
      const di = p.idle - lastCpu.per[i].idle, dt = p.total - lastCpu.per[i].total;
      return dt > 0 ? (1 - di / dt) * 100 : 0;
    });
  }
  lastCpu = { idle, total, per };
  return { usage: Math.max(0, Math.min(100, usage)), perCore };
}
cpuSample();
setInterval(cpuSample, 1000);

// ---- net sampler (/proc/net/dev, fallback: os.networkInterfaces ips only) ----
let lastNet = null;
function netSample() {
  const out = {};
  try {
    const txt = fs.readFileSync("/proc/net/dev", "utf8");
    txt.split("\n").slice(2).forEach(line => {
      const m = line.trim().match(/^([^:]+):\s*(.+)$/);
      if (!m || m[1] === "lo") return;
      const f = m[2].trim().split(/\s+/).map(Number);
      out[m[1]] = { rx: f[0] || 0, tx: f[8] || 0 };
    });
  } catch {}
  const now = Date.now();
  let rxBps = 0, txBps = 0;
  const ifaces = Object.keys(out).map(name => {
    let rx = 0, tx = 0;
    if (lastNet && lastNet.map[name]) {
      const dt = Math.max(1, now - lastNet.t) / 1000;
      rx = (out[name].rx - lastNet.map[name].rx) / dt;
      tx = (out[name].tx - lastNet.map[name].tx) / dt;
      rxBps += Math.max(0, rx); txBps += Math.max(0, tx);
    }
    return { name, ip: ifaceIp(name), rxBps: Math.max(0, rx), txBps: Math.max(0, tx) };
  });
  lastNet = { t: now, map: out };
  return { rxBps, txBps, ifaces };
}
function ifaceIp(name) {
  const all = os.networkInterfaces();
  for (const k of Object.keys(all)) for (const a of all[k]) if (!a.internal && a.family === "IPv4") { if (k === name) return a.address; }
  const flat = []; for (const k of Object.keys(all)) for (const a of all[k]) if (!a.internal && a.family === "IPv4") flat.push(a.address);
  return flat[0] || "";
}
netSample();

// ---- gpus ----
function gpuInfo() {
  const out = [];
  const smi = sh("nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null");
  if (smi.trim()) {
    smi.trim().split("\n").forEach(line => {
      const p = line.split(",").map(s => s.trim());
      out.push({ index: num(p[0]), name: p[1] || "NVIDIA GPU", util: num(p[2]), memUsed: num(p[3]) * 1048576, memTotal: num(p[4]) * 1048576, temp: num(p[5]), power: num(p[6]), fan: num(p[7]) });
    });
    return out;
  }
  const rocm = sh("rocm-smi --showuse --showmeminfo vram --showtemp --csv 2>/dev/null");
  if (rocm.trim()) out.push({ index: 0, name: "AMD GPU (rocm-smi)", util: 0, memUsed: 0, memTotal: 0, temp: 0, power: 0, fan: 0 });
  return out;
}

// ---- disks / io ----
function diskInfo() {
  const mounts = [];
  const df = sh("df -kP 2>/dev/null");
  df.split("\n").slice(1).forEach(line => {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) return;
    const total = num(f[1]) * 1024, used = num(f[2]) * 1024;
    mounts.push({ mount: f[5], dev: f[0], total, used, pct: total ? used / total * 100 : 0 });
  });
  return mounts;
}
let lastDisk = null;
function diskIo() {
  try {
    const txt = fs.readFileSync("/proc/diskstats", "utf8");
    let r = 0, w = 0;
    txt.split("\n").forEach(line => {
      const f = line.trim().split(/\s+/);
      if (f.length > 13 && /^[a-z]+[a-z0-9]*$/.test(f[2]) && !f[2].startsWith("loop")) { r += num(f[5]) * 512; w += num(f[9]) * 512; }
    });
    const now = Date.now();
    let rb = 0, wb = 0;
    if (lastDisk) { const dt = Math.max(1, now - lastDisk.t) / 1000; rb = (r - lastDisk.r) / dt; wb = (w - lastDisk.w) / dt; }
    lastDisk = { t: now, r, w };
    return { readBps: Math.max(0, rb), writeBps: Math.max(0, wb) };
  } catch { return { readBps: 0, writeBps: 0 }; }
}

// ---- processes / apps / ports ----
function appScan() {
  const apps = [];
  const ps = sh("ps -eo pid,pcpu,pmem,comm,args --no-headers 2>/dev/null | head -120");
  const procs = ps.split("\n").filter(Boolean).map(line => {
    const m = line.trim().match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)$/);
    return m ? { pid: m[1], cpu: num(m[2]), mem: num(m[3]), comm: m[4], args: m[5] } : null;
  }).filter(Boolean);
  // listening sockets: ss preferred
  const listen = {};
  let ss = sh("ss -tlnp 2>/dev/null");
  if (!ss.trim()) ss = sh("netstat -tlnp 2>/dev/null");
  ss.split("\n").forEach(line => {
    const m = line.match(/:(\d+)\s.*pid=(\d+)/) || line.match(/:::(\d+)|:(\d+)\s/);
    if (m) {
      const port = num(m[1] || m[2] || m[3] || m[4]);
      const pid = (line.match(/pid=(\d+)/) || [])[1];
      if (port > 0 && port < 65536) listen[port] = listen[port] || { pid };
    }
  });
  const interesting = procs.filter(p => /node|python|bun|deno|java|go$|nginx|postgres|redis|java/i.test(p.comm + " " + p.args));
  const byPort = {};
  Object.keys(listen).forEach(port => {
    const owner = procs.find(p => p.pid === String(listen[port].pid));
    const cmd = owner ? (owner.args || owner.comm) : "";
    const isNode = /node|bun|deno/i.test(cmd), isPy = /python/i.test(cmd);
    byPort[port] = {
      id: "app-" + port, name: guessName(cmd, Number(port)), type: isNode ? "node" : isPy ? "python" : "system",
      ip: localIp(), port: Number(port), status: "running", uptime: procUptime(listen[port].pid),
      cpu: owner ? owner.cpu : 0, mem: owner ? owner.mem : 0, latencyMs: null, cmd: cmd.slice(0, 160)
    };
  });
  Object.values(byPort).forEach(a => apps.push(a));
  // also include node/python procs without detected port
  interesting.slice(0, 20).forEach(p => {
    if (apps.length > 30) return;
    const has = apps.some(a => a.cmd === (p.args || p.comm));
    if (!has && !/ps$|ss$|netstat/.test(p.comm)) apps.push({
      id: "proc-" + p.pid, name: guessName(p.args || p.comm, 0), type: /python/i.test(p.args) ? "python" : /node/i.test(p.args) ? "node" : "system",
      ip: localIp(), port: 0, status: "running", uptime: procUptime(p.pid), cpu: p.cpu, mem: p.mem, latencyMs: null, cmd: (p.args || p.comm).slice(0, 160)
    });
  });
  return { apps, procs: procs.slice(0, 40) };
}
function guessName(cmd, port) {
  const m = String(cmd).match(/([a-zA-Z0-9._-]+)\.(js|py)\b/);
  if (m) return m[1];
  if (/nginx/i.test(cmd)) return "nginx";
  if (/postgres/i.test(cmd)) return "postgres";
  if (port) return "port-" + port;
  return String(cmd).split(" ")[0].split("/").pop().slice(0, 40) || "proc";
}
function procUptime(pid) {
  const s = sh(`ps -o etimes= -p ${pid} 2>/dev/null`).trim();
  return num(s, 0);
}
function localIp() {
  const all = os.networkInterfaces(); const out = [];
  for (const k of Object.keys(all)) for (const a of all[k]) if (!a.internal && a.family === "IPv4") out.push(a.address);
  return out[0] || "127.0.0.1";
}
// active TCP probe for latency on discovered ports
function probePorts(apps) {
  return new Promise(resolve => {
    let pending = apps.filter(a => a.port > 0).length;
    if (!pending) return resolve();
    apps.forEach(a => {
      if (!(a.port > 0)) return;
      const t0 = Date.now();
      const s = net.connect(a.port, "127.0.0.1");
      const done = open => { a.ms = open ? Date.now() - t0 : null; a.open = open; if (--pending === 0) resolve(); s.destroy(); };
      s.setTimeout(1200, () => done(false));
      s.on("connect", () => done(true));
      s.on("error", () => done(false));
    });
  });
}

// ---- docker ----
function dockerInfo() {
  const containers = [];
  const ps = sh("docker ps -a --format '{{json .}}' 2>/dev/null");
  if (!ps.trim()) return containers;
  let stats = {};
  const st = sh("docker stats --no-stream --format '{{json .}}' 2>/dev/null");
  st.split("\n").filter(Boolean).forEach(line => {
    try { const j = JSON.parse(line); stats[j.Name || j.Container] = j; } catch {}
  });
  ps.split("\n").filter(Boolean).forEach(line => {
    try {
      const j = JSON.parse(line);
      const s = stats[j.Names] || {};
      const memUsed = parseBytes(String(s.MemUsage || "").split("/")[0]);
      const memLim = parseBytes(String(s.MemUsage || "").split("/")[1]);
      containers.push({
        id: j.ID, name: j.Names, image: j.Image,
        state: /Up/i.test(j.Status) ? "running" : /Paused/i.test(j.Status) ? "paused" : "exited",
        status: j.Status, cpu: num(String(s.CPUPerc || "").replace("%", "")),
        memUsed, memLimit: memLim, netRx: parseBytes(String(s.NetIO || "").split("/")[0]),
        netTx: parseBytes(String(s.NetIO || "").split("/")[1]),
        ports: j.Ports || "", uptime: 0, restartCount: 0
      });
    } catch {}
  });
  return containers;
}
function parseBytes(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/([\d.]+)\s*([KMGT]?i?B)?/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1048576, GIB: 1073741824, TIB: 1099511627776 };
  const u = (m[2] || "B").toUpperCase();
  return num(m[1]) * (mult[u] || 1);
}

// ---- summary ----
async function buildSummary() {
  const cpu = cpuSample(), netS = netSample(), dio = diskIo();
  const { apps } = appScan();
  await probePorts(apps);
  const ports = apps.filter(a => a.port > 0).map(a => ({ port: a.port, ip: a.ip, proto: "tcp", service: a.name, open: a.open !== false, ms: a.ms ?? a.latencyMs ?? null }));
  ports.push({ port: 22, ip: localIp(), proto: "tcp", service: "ssh", open: true, ms: null });
  return {
    hostname: os.hostname(), time: Date.now(), uptime: os.uptime(),
    specs: {
      os: os.type() + " " + os.release(), kernel: os.release(), arch: os.arch(),
      cpuModel: (os.cpus()[0] || {}).model || "CPU", cpuCores: os.cpus().length,
      memTotal: os.totalmem(), gpus: gpuInfo().map(g => ({ name: g.name, vram: g.memTotal })),
      disks: diskInfo().map(d => ({ mount: d.mount, dev: d.dev, total: d.total })),
      nics: Object.entries(os.networkInterfaces()).flatMap(([name, arr]) => arr.filter(a => a.family === "IPv4").map(a => ({ name, ip: a.address })))
    },
    cpu: { ...cpu, temp: cpuTemp(), load1: os.loadavg()[0] },
    mem: { total: os.totalmem(), used: os.totalmem() - os.freemem(), pct: (os.totalmem() - os.freemem()) / os.totalmem() * 100, swapTotal: 0, swapUsed: 0 },
    gpu: gpuInfo(), disk: { mounts: diskInfo(), ...dio }, net: netS,
    apps, containers: dockerInfo(),
    fsEvents: fsEvents.slice(0, 80), logs: appLogs.slice(0, 80), ports,
    db: db.status()
  };
}
function cpuTemp() {
  try {
    const z = fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8");
    return num(z) / 1000;
  } catch { return 0; }
}

// ---- http ----
function auth(req) {
  if (!TOKEN) return true;
  return req.headers["authorization"] === "Bearer " + TOKEN;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname.startsWith("/api/")) {
      if (!auth(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
      if (u.pathname === "/api/summary") {
        const s = await buildSummary();
        db.saveSnapshot(s);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s)); return;
      }
      if (u.pathname === "/api/history") {
        const limit = parseInt(u.searchParams.get("limit") || "60", 10);
        const history = await db.getHistory(limit);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ history, db: db.status() })); return;
      }
      if (u.pathname === "/api/db") {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(db.status())); return;
      }
      if (u.pathname === "/api/logs") {
        const c = u.searchParams.get("container"), app = u.searchParams.get("app");
        const tail = Math.min(500, num(u.searchParams.get("tail") || "200", 200));
        let lines = [];
        if (c) {
          const out = sh(`docker logs --tail ${tail} "${c.replace(/"/g, "")}" 2>&1 | tail -${tail}`, 8000);
          lines = out.split("\n").filter(Boolean).map(m => ({ t: Date.now(), level: /err|fail|exception/i.test(m) ? "error" : /warn/i.test(m) ? "warn" : "info", src: c, msg: m.slice(0, 500) }));
        } else if (app) {
          lines = appLogs.filter(l => l.src.includes(app)).slice(0, tail);
        } else lines = appLogs.slice(0, tail);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ lines })); return;
      }
      const mRestart = u.pathname.match(/^\/api\/containers\/(.+)\/restart$/);
      if (mRestart && req.method === "POST") {
        const id = mRestart[1].replace(/[^a-zA-Z0-9_.-]/g, "");
        const out = sh(`docker restart "${id}" 2>&1`, 15000);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, out: out.slice(0, 1000) })); return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return;
    }

    if (serveStatic(u.pathname, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not Found");
  } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
});

// Periodic background snapshot persistence to MongoDB
setInterval(async () => {
  if (db.connected) {
    try {
      const s = await buildSummary();
      await db.saveSnapshot(s);
    } catch {}
  }
}, 15000);

// Initialize database
db.init(process.env.MONGO_URI || args["mongo-uri"]);

server.listen(PORT, HOST, () => {
  const hostAddr = HOST === "0.0.0.0" ? "localhost" : HOST;
  const lanIp = localIp();
  console.log(`\n==================================================`);
  console.log(` PulseBoard System Monitor & Collector`);
  console.log(`==================================================`);
  console.log(`  Dashboard:  http://${hostAddr}:${PORT}/`);
  if (lanIp && lanIp !== hostAddr) {
    console.log(`  LAN Access: http://${lanIp}:${PORT}/`);
  }
  console.log(`  Summary:    http://${hostAddr}:${PORT}/api/summary`);
  console.log(`  History:    http://${hostAddr}:${PORT}/api/history`);
  console.log(`  MongoDB:    ${process.env.MONGO_URI || args["mongo-uri"] || "(in-memory / disabled)"}`);
  if (TOKEN) console.log("  Token auth: enabled");
  else console.log("  Mode:       open access (set --token for auth)");
  console.log(`==================================================\n`);
});
