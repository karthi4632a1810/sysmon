const { MongoClient } = require("mongodb");

class DBManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.connected = false;
    this.connecting = false;
    this.url = process.env.MONGO_URI || "";
    this.dbName = process.env.MONGO_DB || "sysmon";
    this.lastError = null;
  }

  async init(url = null) {
    if (url) this.url = url;
    if (!this.url) {
      console.log("ℹ️  MongoDB: No MONGO_URI provided. Running in in-memory mode.");
      return;
    }
    await this.connect();
  }

  async connect() {
    if (this.connected || this.connecting || !this.url) return;
    this.connecting = true;
    try {
      this.client = new MongoClient(this.url, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.connected = true;
      this.lastError = null;
      console.log(`✅ MongoDB connected: ${this.url.replace(/\/\/[^@]+@/, "//***@")} (DB: ${this.dbName})`);

      // Ensure indexes with TTL
      await this.db.collection("snapshots").createIndex({ time: -1 });
      await this.db.collection("snapshots").createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 7 }); // 7-day TTL
      await this.db.collection("alerts").createIndex({ t: -1 });
      await this.db.collection("alerts").createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 14 }); // 14-day TTL
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      console.warn(`⚠️ MongoDB connection error: ${err.message}. Retrying in 5s...`);
      setTimeout(() => this.connect(), 5000);
    } finally {
      this.connecting = false;
    }
  }

  async saveSnapshot(summary) {
    if (!this.connected || !this.db) return;
    try {
      const doc = {
        hostname: summary.hostname,
        time: summary.time || Date.now(),
        createdAt: new Date(),
        uptime: summary.uptime,
        cpu: summary.cpu,
        mem: summary.mem,
        gpu: summary.gpu,
        disk: summary.disk,
        net: summary.net,
        appsCount: (summary.apps || []).length,
        containersCount: (summary.containers || []).length,
      };
      await this.db.collection("snapshots").insertOne(doc);
    } catch (err) {
      console.error("Failed to save snapshot to MongoDB:", err.message);
    }
  }

  async saveAlert(alert) {
    if (!this.connected || !this.db) return;
    try {
      const doc = {
        ...alert,
        createdAt: new Date(),
        t: alert.t || Date.now()
      };
      await this.db.collection("alerts").insertOne(doc);
    } catch (err) {
      console.error("Failed to save alert to MongoDB:", err.message);
    }
  }

  async getHistory(limit = 60) {
    if (!this.connected || !this.db) return [];
    try {
      return await this.db.collection("snapshots")
        .find({})
        .sort({ time: -1 })
        .limit(Math.min(300, Number(limit) || 60))
        .toArray();
    } catch (err) {
      return [];
    }
  }

  async getAlerts(limit = 100) {
    if (!this.connected || !this.db) return [];
    try {
      return await this.db.collection("alerts")
        .find({})
        .sort({ t: -1 })
        .limit(Math.min(300, Number(limit) || 100))
        .toArray();
    } catch (err) {
      return [];
    }
  }

  status() {
    return {
      connected: this.connected,
      uri: this.url ? this.url.replace(/\/\/[^@]+@/, "//***@") : "none",
      db: this.dbName,
      lastError: this.lastError
    };
  }
}

module.exports = new DBManager();

