const { Client } = require("ssh2");

// Configuration for Agentless VPS SSH Connection
const SSH_CONFIG = {
  host: process.env.VPS_SSH_HOST || "192.168.101.116",
  port: parseInt(process.env.VPS_SSH_PORT || "22", 10),
  username: process.env.VPS_SSH_USER || "mapims",
  password: process.env.VPS_SSH_PASSWORD || "inhouse@67",
  readyTimeout: 10000,
  keepaliveInterval: 10000
};

let activeClient = null;
let clientConnecting = false;
let lastSummary = null;
let lastSummaryTime = 0;
let lastCpuStat = null;

function num(v, d = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
}

function parseBytes(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/([\d.]+)\s*([KMGT]?i?B)?/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1048576, GIB: 1073741824, TIB: 1099511627776 };
  const u = (m[2] || "B").toUpperCase();
  return num(m[1]) * (mult[u] || 1);
}

function getClient() {
  return new Promise((resolve, reject) => {
    if (activeClient && activeClient._sock && activeClient._sock.writable) {
      return resolve(activeClient);
    }
    if (clientConnecting) {
      setTimeout(() => getClient().then(resolve).catch(reject), 300);
      return;
    }
    clientConnecting = true;
    const conn = new Client();
    conn.on("ready", () => {
      activeClient = conn;
      clientConnecting = false;
      resolve(conn);
    });
    conn.on("error", (err) => {
      activeClient = null;
      clientConnecting = false;
      reject(err);
    });
    conn.on("end", () => {
      activeClient = null;
      clientConnecting = false;
    });
    conn.on("close", () => {
      activeClient = null;
      clientConnecting = false;
    });
    conn.connect(SSH_CONFIG);
  });
}

function execSsh(cmd, timeoutMs = 12000) {
  return new Promise(async (resolve, reject) => {
    let timer = null;
    try {
      const conn = await getClient();
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "", stderr = "";
        timer = setTimeout(() => {
          stream.destroy();
          reject(new Error("SSH command timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
        stream.on("data", (d) => { stdout += d; });
        stream.stderr.on("data", (d) => { stderr += d; });
        stream.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      reject(e);
    }
  });
}

async function getSummary() {
  const now = Date.now();
  // Cache for 1200ms to keep response times under 50ms on frequent polls
  if (lastSummary && (now - lastSummaryTime < 1200)) {
    return lastSummary;
  }

  const batchCmd = `
echo "===HOSTNAME==="
hostname
echo "===UNAME==="
uname -s -r -m
echo "===MEMINFO==="
cat /proc/meminfo
echo "===STAT==="
head -n 20 /proc/stat
echo "===UPTIME==="
cat /proc/uptime
echo "===DF==="
df -k -P
echo "===NET==="
cat /proc/net/dev
echo "===PS==="
docker ps -a --format "{{json .}}" 2>/dev/null
echo "===STATS==="
docker stats --no-stream --format "{{json .}}" 2>/dev/null
`;

  const { stdout } = await execSsh(batchCmd);
  const sections = {};
  const regex = /===([A-Z]+)===\n([\s\S]*?)(?=(?:===[A-Z]+===|$))/g;
  let m;
  while ((m = regex.exec(stdout)) !== null) {
    sections[m[1]] = m[2].trim();
  }

  // 1. Hostname & specs
  const hostname = (sections["HOSTNAME"] || "vps-server").split("\n")[0].trim();
  const uname = (sections["UNAME"] || "").split(" ");
  const osType = uname[0] || "Linux";
  const kernel = uname[1] || "";
  const arch = uname[2] || "x86_64";

  // 2. Memory Info
  const meminfo = {};
  (sections["MEMINFO"] || "").split("\n").forEach(l => {
    const p = l.split(":");
    if (p.length === 2) meminfo[p[0].trim()] = num(p[1]);
  });
  const memTotal = (meminfo["MemTotal"] || 0) * 1024;
  const memFree = (meminfo["MemFree"] || 0) * 1024;
  const memAvail = (meminfo["MemAvailable"] || memFree) * 1024;
  const memUsed = Math.max(0, memTotal - memAvail);
  const memPct = memTotal > 0 ? (memUsed / memTotal * 100) : 0;
  const swapTotal = (meminfo["SwapTotal"] || 0) * 1024;
  const swapFree = (meminfo["SwapFree"] || 0) * 1024;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  // 3. CPU & Per-Core calculation from /proc/stat
  let cpuUsage = 0;
  const perCore = [];
  const statLines = (sections["STAT"] || "").split("\n");
  const curCpuStat = [];
  statLines.forEach(l => {
    const parts = l.trim().split(/\s+/);
    if (/^cpu\d*$/.test(parts[0])) {
      const user = num(parts[1]), nice = num(parts[2]), sys = num(parts[3]), idle = num(parts[4]), iowait = num(parts[5]);
      curCpuStat.push({ name: parts[0], total: user + nice + sys + idle + iowait, idle: idle + iowait });
    }
  });

  if (lastCpuStat && lastCpuStat.length === curCpuStat.length) {
    for (let i = 0; i < curCpuStat.length; i++) {
      const dt = curCpuStat[i].total - lastCpuStat[i].total;
      const di = curCpuStat[i].idle - lastCpuStat[i].idle;
      const pct = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
      if (curCpuStat[i].name === "cpu") cpuUsage = pct;
      else perCore.push(pct);
    }
  } else {
    cpuUsage = 0;
  }
  lastCpuStat = curCpuStat;

  // 4. Uptime
  const uptimeSec = num((sections["UPTIME"] || "").split(" ")[0]);

  // 5. Disks from df
  const mounts = [];
  (sections["DF"] || "").split("\n").slice(1).forEach(l => {
    const p = l.trim().split(/\s+/);
    if (p.length >= 6 && (p[0].startsWith("/dev/") || p[5] === "/")) {
      const total = num(p[1]) * 1024;
      const used = num(p[2]) * 1024;
      const avail = num(p[3]) * 1024;
      const pct = total > 0 ? Math.round((used / total) * 100) : 0;
      mounts.push({ mount: p[5], dev: p[0], total, used, avail, pct });
    }
  });

  // 6. Network from /proc/net/dev
  let rxBps = 0, txBps = 0;
  const ifaces = [];
  (sections["NET"] || "").split("\n").slice(2).forEach(l => {
    const col = l.trim().split(/[:\s]+/);
    if (col.length >= 10 && col[0] !== "lo") {
      const rx = num(col[1]);
      const tx = num(col[9]);
      ifaces.push({ name: col[0], ip: SSH_CONFIG.host, rxBps: rx, txBps: tx });
    }
  });

  // 7. Containers
  const statsMap = {};
  (sections["STATS"] || "").split("\n").filter(Boolean).forEach(l => {
    try {
      const j = JSON.parse(l);
      statsMap[j.Name || j.Container] = j;
    } catch {}
  });

  const containers = [];
  (sections["PS"] || "").split("\n").filter(Boolean).forEach(l => {
    try {
      const j = JSON.parse(l);
      const s = statsMap[j.Names] || {};
      const memUsed = parseBytes(String(s.MemUsage || "").split("/")[0]);
      const memLim = parseBytes(String(s.MemUsage || "").split("/")[1]);
      const isUp = /Up/i.test(j.Status);
      containers.push({
        id: j.ID,
        name: j.Names,
        image: j.Image,
        state: isUp ? "running" : /Paused/i.test(j.Status) ? "paused" : "exited",
        status: j.Status,
        cpu: num(String(s.CPUPerc || "").replace("%", "")),
        memUsed: memUsed,
        memLimit: memLim || memTotal,
        netRx: parseBytes(String(s.NetIO || "").split("/")[0]),
        netTx: parseBytes(String(s.NetIO || "").split("/")[1]),
        ports: j.Ports || "",
        uptime: 0,
        restartCount: 0
      });
    } catch {}
  });

  // 8. Ports inferred from containers
  const ports = [];
  containers.forEach(c => {
    if (c.ports) {
      const matches = c.ports.matchAll(/(?:0\.0\.0\.0|\[::\]):(\d+)->(\d+)/g);
      for (const match of matches) {
        ports.push({
          port: parseInt(match[1], 10),
          ip: SSH_CONFIG.host,
          proto: "tcp",
          service: c.name,
          open: c.state === "running",
          ms: 1
        });
      }
    }
  });

  const summary = {
    hostname: hostname || "admin",
    time: Date.now(),
    uptime: uptimeSec,
    specs: {
      os: osType,
      kernel: kernel,
      arch: arch,
      cpuModel: "VPS Virtual CPU",
      cpuCores: perCore.length || 4,
      memTotal: memTotal,
      gpus: [],
      disks: mounts,
      nics: [{ name: "eth0", ip: SSH_CONFIG.host }]
    },
    cpu: {
      usage: cpuUsage,
      perCore: perCore,
      temp: 0,
      load1: 1.0
    },
    mem: {
      total: memTotal,
      used: memUsed,
      pct: memPct,
      swapTotal: swapTotal,
      swapUsed: swapUsed
    },
    gpu: [],
    disk: {
      mounts: mounts,
      readBps: 0,
      writeBps: 0
    },
    net: {
      rxBps: rxBps,
      txBps: txBps,
      ifaces: ifaces
    },
    apps: [],
    containers: containers,
    fsEvents: [],
    logs: [],
    ports: ports,
    db: { connected: false },
    agentless: true,
    sshHost: SSH_CONFIG.host
  };

  lastSummary = summary;
  lastSummaryTime = now;
  return summary;
}

async function getLogs(container, tail = 200) {
  const safeName = String(container).replace(/[^a-zA-Z0-9_.-]/g, "");
  const cmd = `docker logs --tail ${tail} --timestamps "${safeName}" 2>&1`;
  const { stdout } = await execSsh(cmd, 10000);
  const lines = stdout.split("\n").filter(Boolean).map(m => {
    let t = Date.now();
    let msg = m;
    const tm = m.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
    if (tm) {
      const parsed = Date.parse(tm[1]);
      if (!isNaN(parsed)) t = parsed;
      msg = tm[2];
    }
    const level = /err|fail|exception|fatal/i.test(msg) ? "error" : /warn/i.test(msg) ? "warn" : "info";
    return { t, level, src: safeName, msg: msg.slice(0, 1000) };
  });
  return { container: safeName, count: lines.length, lines, raw: stdout };
}

async function containerAction(container, action) {
  const safeName = String(container).replace(/[^a-zA-Z0-9_.-]/g, "");
  const validActions = ["restart", "stop", "start"];
  if (!validActions.includes(action)) throw new Error("Invalid action " + action);
  const cmd = `docker ${action} "${safeName}" 2>&1`;
  const { stdout, code } = await execSsh(cmd, 15000);
  return { ok: code === 0, action, container: safeName, out: stdout.trim() };
}

module.exports = {
  getSummary,
  getLogs,
  containerAction,
  SSH_CONFIG
};
