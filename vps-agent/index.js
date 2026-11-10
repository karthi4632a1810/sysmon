#!/usr/bin/env node
/**
 * SysMon VPS Telemetry & Docker Agent
 * Runs on VPS (Docker Port 55555)
 * Provides real-time RAM, CPU, Docker status, container stats, logs and controls.
 */

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const PORT = parseInt(process.env.PORT || "55555", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.AUTH_TOKEN || "";

function sh(cmd, timeout = 5000) {
  try {
    return cp.execSync(cmd, { timeout, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

function parseBytes(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/([\d.]+)\s*([KMGT]?i?B)?/i);
  if (!m) return 0;
  const mult = {
    B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
    KIB: 1024, MIB: 1048576, GIB: 1073741824, TIB: 1099511627776
  };
  const u = (m[2] || "B").toUpperCase();
  const val = parseFloat(m[1]);
  return isFinite(val) ? Math.round(val * (mult[u] || 1)) : 0;
}

function localIp() {
  const all = os.networkInterfaces();
  for (const k of Object.keys(all)) {
    for (const a of all[k]) {
      if (!a.internal && a.family === "IPv4") return a.address;
    }
  }
  return "127.0.0.1";
}

// ==========================================
// 1. Memory / RAM Metrics
// ==========================================
function readMem() {
  const paths = ["/host/proc/meminfo", "/proc/meminfo"];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8");
        const map = {};
        txt.split("\n").forEach(line => {
          const m = line.match(/^([a-zA-Z0-9_]+):\s*(\d+)/);
          if (m) map[m[1]] = parseInt(m[2], 10) * 1024;
        });
        if (map.MemTotal) {
          const total = map.MemTotal;
          const avail = map.MemAvailable !== undefined ? map.MemAvailable : (map.MemFree || 0);
          const used = Math.max(0, total - avail);
          const pct = total > 0 ? (used / total) * 100 : 0;
          return {
            total,
            used,
            free: avail,
            pct: Number(pct.toFixed(1)),
            swapTotal: map.SwapTotal || 0,
            swapUsed: Math.max(0, (map.SwapTotal || 0) - (map.SwapFree || 0))
          };
        }
      }
    } catch {}
  }
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return {
    total,
    used,
    free,
    pct: Number(((used / total) * 100).toFixed(1)),
    swapTotal: 0,
    swapUsed: 0
  };
}

// ==========================================
// 2. CPU Metrics
// ==========================================
let lastCpu = null;
function sampleCpu() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  const per = cpus.map(c => {
    const t = c.times;
    const tt = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total: tt };
  });
  cpus.forEach(c => {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  });
  let usage = 0;
  let perCore = per.map(() => 0);
  if (lastCpu && total > lastCpu.total) {
    const dIdle = idle - lastCpu.idle;
    const dTotal = total - lastCpu.total;
    usage = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    perCore = per.map((p, i) => {
      const last = lastCpu.per[i];
      if (!last) return 0;
      const di = p.idle - last.idle;
      const dt = p.total - last.total;
      return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
    });
  }
  lastCpu = { idle, total, per };
  return {
    usage: Number(Math.max(0, Math.min(100, usage)).toFixed(1)),
    perCore: perCore.map(v => Number(v.toFixed(1))),
    load1: Number((os.loadavg()[0] || 0).toFixed(2)),
    cores: cpus.length,
    model: cpus[0] ? cpus[0].model : "Generic CPU"
  };
}
// Prime CPU sampler
sampleCpu();
setInterval(sampleCpu, 2000);

// ==========================================
// 3. Disk & Network Metrics
// ==========================================
function getDisks() {
  const mounts = [];
  const df = sh("df -kP 2>/dev/null");
  if (df) {
    df.split("\n").slice(1).forEach(line => {
      const f = line.trim().split(/\s+/);
      if (f.length >= 6 && !f[0].startsWith("tmpfs") && !f[0].startsWith("overlay")) {
        const total = parseInt(f[1], 10) * 1024;
        const used = parseInt(f[2], 10) * 1024;
        mounts.push({
          mount: f[5],
          dev: f[0],
          total,
          used,
          pct: total ? Number(((used / total) * 100).toFixed(1)) : 0
        });
      }
    });
  }
  if (!mounts.length) {
    mounts.push({ mount: "/", dev: "/dev/root", total: 100 * 1e9, used: 25 * 1e9, pct: 25 });
  }
  return mounts;
}

let lastNet = null;
function getNet() {
  const out = {};
  const paths = ["/host/proc/net/dev", "/proc/net/dev"];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8");
        txt.split("\n").slice(2).forEach(line => {
          const m = line.trim().match(/^([^:]+):\s*(.+)$/);
          if (m && m[1] !== "lo") {
            const f = m[2].trim().split(/\s+/).map(Number);
            out[m[1]] = { rx: f[0] || 0, tx: f[8] || 0 };
          }
        });
        break;
      }
    } catch {}
  }
  const now = Date.now();
  let rxBps = 0, txBps = 0;
  const ifaces = Object.keys(out).map(name => {
    let rx = 0, tx = 0;
    if (lastNet && lastNet.map[name]) {
      const dt = Math.max(1, now - lastNet.t) / 1000;
      rx = (out[name].rx - lastNet.map[name].rx) / dt;
      tx = (out[name].tx - lastNet.map[name].tx) / dt;
      rxBps += Math.max(0, rx);
      txBps += Math.max(0, tx);
    }
    return { name, ip: localIp(), rxBps: Math.round(rx), txBps: Math.round(tx) };
  });
  lastNet = { t: now, map: out };
  return { rxBps: Math.round(rxBps), txBps: Math.round(txBps), ifaces };
}
getNet();

function getNics() {
  const all = os.networkInterfaces();
  const nics = [];
  for (const [name, arr] of Object.entries(all)) {
    for (const a of arr) {
      if (a.family === "IPv4") nics.push({ name, ip: a.address });
    }
  }
  return nics;
}

// ==========================================
// 4. Real Docker Status & Container Inspection
// ==========================================
function getDockerDetails() {
  const dockerInfo = {
    installed: false,
    running: false,
    version: "",
    total: 0,
    running: 0,
    paused: 0,
    stopped: 0
  };

  const vOut = sh("docker version --format '{{.Server.Version}}' 2>/dev/null").trim();
  if (!vOut) {
    const which = sh("which docker 2>/dev/null").trim();
    dockerInfo.installed = Boolean(which);
    return { docker: dockerInfo, containers: [] };
  }

  dockerInfo.installed = true;
  dockerInfo.running = true;
  dockerInfo.version = vOut;

  // 1. Fetch live container CPU / Memory stats
  const statsMap = {};
  const statsRaw = sh("docker stats --no-stream --format '{{json .}}' 2>/dev/null");
  if (statsRaw) {
    statsRaw.split("\n").filter(Boolean).forEach(line => {
      try {
        const j = JSON.parse(line.trim());
        const name = j.Name || j.Container;
        if (name) statsMap[name] = j;
        if (j.ID) statsMap[j.ID] = j;
      } catch {}
    });
  }

  // 2. Fetch full container inventory
  const containers = [];
  const psRaw = sh("docker ps -a --format '{{json .}}' 2>/dev/null");
  if (psRaw) {
    psRaw.split("\n").filter(Boolean).forEach(line => {
      try {
        const c = JSON.parse(line.trim());
        const stat = statsMap[c.Names] || statsMap[c.ID] || {};

        const isRunning = /up/i.test(c.Status);
        const isPaused = /paused/i.test(c.Status);

        if (isRunning) dockerInfo.running++;
        else if (isPaused) dockerInfo.paused++;
        else dockerInfo.stopped++;
        dockerInfo.total++;

        const memParts = String(stat.MemUsage || "").split("/");
        const memUsed = parseBytes(memParts[0]);
        const memLimit = parseBytes(memParts[1]);

        const netParts = String(stat.NetIO || "").split("/");
        const netRx = parseBytes(netParts[0]);
        const netTx = parseBytes(netParts[1]);

        const cpuPct = parseFloat(String(stat.CPUPerc || "0").replace("%", "")) || 0;
        const memPct = parseFloat(String(stat.MemPerc || "0").replace("%", "")) || (memLimit > 0 ? (memUsed / memLimit) * 100 : 0);

        containers.push({
          id: c.ID,
          name: c.Names,
          image: c.Image,
          state: isRunning ? "running" : isPaused ? "paused" : "exited",
          status: c.Status,
          created: c.CreatedAt,
          ports: c.Ports || "",
          cpu: Number(cpuPct.toFixed(1)),
          memUsed,
          memLimit,
          memPct: Number(memPct.toFixed(1)),
          netRx,
          netTx,
          restartCount: 0
        });
      } catch {}
    });
  }

  return { docker: dockerInfo, containers };
}

// ==========================================
// 5. Build Unified Snapshot
// ==========================================
function buildSummary() {
  const cpu = sampleCpu();
  const mem = readMem();
  const net = getNet();
  const disks = getDisks();
  const { docker, containers } = getDockerDetails();

  // Ports exposed by containers and host
  const ports = containers.filter(c => c.ports).map(c => ({
    port: c.ports,
    ip: localIp(),
    proto: "tcp",
    service: c.name,
    open: c.state === "running"
  }));
  ports.push({ port: PORT, ip: localIp(), proto: "tcp", service: "vps-agent", open: true });

  return {
    hostname: os.hostname(),
    time: Date.now(),
    uptime: Math.round(os.uptime()),
    ip: localIp(),
    agentPort: PORT,
    specs: {
      os: os.type() + " " + os.release(),
      kernel: os.release(),
      arch: os.arch(),
      cpuModel: cpu.model,
      cpuCores: cpu.cores,
      memTotal: mem.total,
      disks,
      nics: getNics()
    },
    cpu: {
      usage: cpu.usage,
      perCore: cpu.perCore,
      load1: cpu.load1
    },
    mem,
    docker,
    containers,
    apps: containers.map(c => ({
      id: "c-" + c.id,
      name: c.name,
      type: "docker",
      ip: localIp(),
      port: c.ports || 0,
      status: c.state,
      cpu: c.cpu,
      mem: c.memPct,
      cmd: c.image
    })),
    disk: { mounts: disks, readBps: 0, writeBps: 0 },
    net,
    ports,
    fsEvents: [],
    logs: []
  };
}

// ==========================================
// 6. HTTP Server & Endpoints
// ==========================================
function auth(req) {
  if (!TOKEN) return true;
  return req.headers["authorization"] === "Bearer " + TOKEN;
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, "http://localhost");

  try {
    if (!auth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // --- A. Telemetry Summary ---
    if (u.pathname === "/" || u.pathname === "/api/summary" || u.pathname === "/status") {
      const summary = buildSummary();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(summary, null, 2));
      return;
    }

    // --- B. Docker Status & Containers Only ---
    if (u.pathname === "/api/docker" || u.pathname === "/docker") {
      const { docker, containers } = getDockerDetails();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ docker, count: containers.length, containers }, null, 2));
      return;
    }

    // --- C. RAM & CPU Only ---
    if (u.pathname === "/api/system" || u.pathname === "/system") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ cpu: sampleCpu(), mem: readMem(), uptime: os.uptime() }, null, 2));
      return;
    }

    // --- D. Real Docker Logs ---
    if (u.pathname === "/api/logs" || u.pathname === "/logs") {
      const c = u.searchParams.get("container") || u.searchParams.get("id");
      const tail = Math.min(1000, parseInt(u.searchParams.get("tail") || "200", 10));
      if (!c) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing ?container=NAME parameter" }));
        return;
      }

      const safeName = c.replace(/[^a-zA-Z0-9_.-]/g, "");
      const raw = sh(`docker logs --tail ${tail} --timestamps "${safeName}" 2>&1`, 8000);
      const lines = raw.split("\n").filter(Boolean).map(m => {
        let t = Date.now();
        let msg = m;
        // Parse docker timestamp prefix if present (e.g. 2026-11-10T05:30:00.000000000Z)
        const tm = m.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
        if (tm) {
          const parsed = Date.parse(tm[1]);
          if (!isNaN(parsed)) t = parsed;
          msg = tm[2];
        }
        const level = /err|fail|exception|fatal/i.test(msg) ? "error" : /warn/i.test(msg) ? "warn" : "info";
        return { t, level, src: safeName, msg: msg.slice(0, 1000) };
      });

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ container: safeName, count: lines.length, lines, raw }));
      return;
    }

    // --- E. Container Actions: Restart, Start, Stop ---
    const mRestart = u.pathname.match(/^\/api\/containers\/([^/]+)\/restart$/);
    if (mRestart && req.method === "POST") {
      const id = mRestart[1].replace(/[^a-zA-Z0-9_.-]/g, "");
      const out = sh(`docker restart "${id}" 2>&1`, 15000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: "restart", container: id, out: out.trim() }));
      return;
    }

    const mStop = u.pathname.match(/^\/api\/containers\/([^/]+)\/stop$/);
    if (mStop && req.method === "POST") {
      const id = mStop[1].replace(/[^a-zA-Z0-9_.-]/g, "");
      const out = sh(`docker stop "${id}" 2>&1`, 15000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: "stop", container: id, out: out.trim() }));
      return;
    }

    const mStart = u.pathname.match(/^\/api\/containers\/([^/]+)\/start$/);
    if (mStart && req.method === "POST") {
      const id = mStart[1].replace(/[^a-zA-Z0-9_.-]/g, "");
      const out = sh(`docker start "${id}" 2>&1`, 15000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: "start", container: id, out: out.trim() }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "Endpoint not found",
      availableEndpoints: [
        "GET /api/summary",
        "GET /api/docker",
        "GET /api/system",
        "GET /api/logs?container=NAME&tail=200",
        "POST /api/containers/:id/restart",
        "POST /api/containers/:id/start",
        "POST /api/containers/:id/stop"
      ]
    }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal Server Error" }));
  }
});

server.listen(PORT, HOST, () => {
  const lan = localIp();
  console.log(`\n======================================================`);
  console.log(` 🚀 SysMon VPS Agent running on port ${PORT}`);
  console.log(`======================================================`);
  console.log(`  Summary:       http://localhost:${PORT}/api/summary`);
  if (lan) {
    console.log(`  LAN / Remote:  http://${lan}:${PORT}/api/summary`);
  }
  console.log(`  Docker status: http://localhost:${PORT}/api/docker`);
  console.log(`  Container logs:http://localhost:${PORT}/api/logs?container=NAME`);
  console.log(`  Auth:          ${TOKEN ? "Enabled (Bearer token required)" : "Open access"}`);
  console.log(`======================================================\n`);
});

