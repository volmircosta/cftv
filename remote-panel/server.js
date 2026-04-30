import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const clipCacheDir = process.env.CLIP_CACHE_DIR || path.join(dataDir, "clips");
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const playbackInternalUrl = process.env.PLAYBACK_INTERNAL_URL || "http://mediamtx:9996";
const playbackPublicUrl = process.env.PLAYBACK_PUBLIC_URL || "http://172.16.21.122:9996";
const mediaMtxApiUrl = process.env.MEDIAMTX_API_URL || "http://mediamtx:9997";
const rtmpPublicHost = process.env.RTMP_PUBLIC_HOST || "172.16.21.122";
const nvrHost = process.env.NVR_HOST || "192.168.10.76";
const nvrPort = Number(process.env.NVR_PORT || 34567);
const nvrUser = process.env.NVR_USER || "portalcom";
const nvrPassword = process.env.NVR_PASSWORD || "p0r74lc0m";
const maxNvrDownloadBytes = Number(process.env.MAX_NVR_DOWNLOAD_BYTES || 256 * 1024 * 1024);
const ixcBaseUrl = (process.env.IXC_BASE_URL || "").replace(/\/+$/, "");
const ixcCredentials = process.env.IXC_CREDENTIALS || "";
const ixcProductId = process.env.IXC_CFTV_PRODUCT_ID || "13518";
const ixcProductName = process.env.IXC_CFTV_PRODUCT_NAME || "CFTV - FL 1";
const ixcDefaultGroupId = process.env.IXC_CFTV_GROUP_ID || "principal";
const ixcDefaultPassword = process.env.IXC_DEFAULT_PASSWORD || "portalcom2026";
const ixcSyncHour = Number(process.env.IXC_SYNC_HOUR || 12);
const sessions = new Map();
const nvrClipJobs = new Map();
const alarmState = { connected: false, lastError: "", lastEventAt: null, startedAt: null };

const defaultCameras = Array.from({ length: 8 }, (_, i) => ({
  id: `camera${i + 1}`,
  name: `Camera ${i + 1}`,
  groupId: "principal",
  webrtcUrl: `http://172.16.21.122:8889/camera${i + 1}/`,
  hlsUrl: `http://172.16.21.122:8888/camera${i + 1}/`,
  enabled: true
}));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function defaultGroups() {
  return [{ id: "principal", name: "Principal" }];
}

function normalizeDb(db) {
  db.groups = Array.isArray(db.groups) && db.groups.length ? db.groups : defaultGroups();
  db.cameras = Array.isArray(db.cameras) && db.cameras.length ? db.cameras : defaultCameras;
  db.cameras = db.cameras.map((camera, index) => ({
    id: camera.id || `camera${index + 1}`,
    name: camera.name || `Camera ${index + 1}`,
    groupId: camera.groupId || "principal",
    sourceUrl: camera.sourceUrl || "",
    sourceType: camera.sourceType === "rtmp" ? (camera.sourceUrl ? "rtmp_pull" : "rtmp_push") : (camera.sourceType || (camera.sourceUrl ? "rtmp_pull" : "rtsp")),
    webrtcUrl: camera.webrtcUrl || `http://172.16.21.122:8889/camera${index + 1}/`,
    hlsUrl: camera.hlsUrl || `http://172.16.21.122:8888/camera${index + 1}/`,
    enabled: camera.enabled !== false
  }));
  db.users = Array.isArray(db.users) ? db.users : [];
  db.users = db.users.map((user) => ({
    ...user,
    cameras: Array.isArray(user.cameras) ? user.cameras : [],
    groups: Array.isArray(user.groups) ? user.groups : []
  }));
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  db.alarms = Array.isArray(db.alarms) ? db.alarms : [];
  return db;
}

function nextCameraId(db) {
  const used = new Set((db.cameras || []).map((camera) => camera.id));
  let index = 1;
  while (used.has(`camera${index}`)) index++;
  return `camera${index}`;
}

function cameraWithUrls(camera) {
  return {
    ...camera,
    rtmpPushUrl: `rtmp://${rtmpPublicHost}:1935/${camera.id}`
  };
}

async function loadDb() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    const initial = normalizeDb({
      users: [{
        id: crypto.randomUUID(),
        username: "admin",
        passwordHash: hashPassword("portalcom2026"),
        role: "admin",
        cameras: defaultCameras.map((camera) => camera.id),
        active: true
      }],
      groups: defaultGroups(),
      cameras: defaultCameras,
      audit: []
    });
    await writeFile(dbPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  return normalizeDb(JSON.parse(await readFile(dbPath, "utf8")));
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(normalizeDb(db), null, 2));
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === "string" || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJsonWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function mediaMtxPathConfig(camera) {
  return {
    source: camera.sourceType === "rtmp_pull" && camera.sourceUrl ? camera.sourceUrl : "publisher",
    rtspTransport: "tcp",
    record: true,
    recordPath: "/recordings/%path/%Y-%m-%d_%H-%M-%S-%f",
    recordFormat: "fmp4",
    recordPartDuration: "1s",
    recordSegmentDuration: "2m",
    recordDeleteAfter: "72h"
  };
}

async function putMediaMtxPath(camera) {
  if (!camera?.id || !String(camera.sourceType || "").startsWith("rtmp")) return;
  const config = mediaMtxPathConfig(camera);
  const name = encodeURIComponent(camera.id);
  const patch = await fetch(`${mediaMtxApiUrl}/v3/config/paths/patch/${name}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
  if (patch.ok) return;
  const add = await fetch(`${mediaMtxApiUrl}/v3/config/paths/add/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
  if (!add.ok) throw new Error(`MediaMTX nao aceitou ${camera.id}: ${await add.text()}`);
}

async function syncMediaMtxCamera(camera) {
  try {
    await putMediaMtxPath(camera);
  } catch (error) {
    console.error("MediaMTX camera sync failed", camera?.id, error.message || error);
  }
}

async function syncMediaMtxCameras(db) {
  for (const camera of db.cameras.filter((item) => String(item.sourceType || "").startsWith("rtmp"))) await syncMediaMtxCamera(camera);
}

function ixcEnabled() {
  return Boolean(ixcBaseUrl && ixcCredentials);
}

async function ixcList(endpoint, body, ms = 30000) {
  if (!ixcEnabled()) throw new Error("IXC nao configurado");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const auth = Buffer.from(ixcCredentials, "utf8").toString("base64");
    const response = await fetch(`${ixcBaseUrl}/webservice/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        "ixcsoft": "listar"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`IXC HTTP ${response.status}`);
    const data = await response.json();
    const registros = data.registros ? (Array.isArray(data.registros) ? data.registros : [data.registros]) : [];
    return { ...data, registros };
  } finally {
    clearTimeout(timer);
  }
}

function ixcListBody(qtype, query, oper = "=", rp = "100", page = "1") {
  return { qtype, query: String(query), oper, page: String(page), rp: String(rp), sortname: qtype, sortorder: "asc" };
}

function isIxcContractActive(contract, client) {
  return client?.ativo !== "N" && contract?.status === "A" && contract?.status_internet === "A";
}

function makeIxcPasswordHash(user) {
  if (user.passwordHash && user.ixcManaged) return user.passwordHash;
  return hashPassword(ixcDefaultPassword);
}

async function syncIxcUsers(db, options = {}) {
  if (!ixcEnabled()) return { enabled: false, created: 0, updated: 0, disabled: 0, total: 0 };
  const products = await ixcList("vd_contratos_produtos", ixcListBody("vd_contratos_produtos.id_produto", ixcProductId, "=", "500"));
  const managedEmails = new Set();
  const summary = { enabled: true, created: 0, updated: 0, disabled: 0, skipped: 0, total: products.registros.length };
  for (const product of products.registros) {
    const contractId = product.id_contrato || product.id_vd_contrato;
    if (!contractId || contractId === "0") {
      summary.skipped++;
      continue;
    }
    const contracts = await ixcList("cliente_contrato", ixcListBody("cliente_contrato.id", contractId, "=", "1"));
    const contract = contracts.registros[0];
    if (!contract?.id_cliente) {
      summary.skipped++;
      continue;
    }
    const clients = await ixcList("cliente", ixcListBody("cliente.id", contract.id_cliente, "=", "1"));
    const client = clients.registros[0];
    const email = String(client?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      summary.skipped++;
      continue;
    }
    managedEmails.add(email);
    const active = isIxcContractActive(contract, client);
    let panelUser = db.users.find((item) => item.username.toLowerCase() === email);
    if (!panelUser) {
      panelUser = {
        id: crypto.randomUUID(),
        username: email,
        passwordHash: hashPassword(ixcDefaultPassword),
        role: "viewer",
        cameras: [],
        groups: [ixcDefaultGroupId],
        active,
        ixcManaged: true,
        ixcClientId: client.id,
        ixcContractId: contract.id,
        ixcProductId
      };
      db.users.push(panelUser);
      summary.created++;
    } else {
      const before = JSON.stringify({
        active: panelUser.active,
        groups: panelUser.groups,
        ixcClientId: panelUser.ixcClientId,
        ixcContractId: panelUser.ixcContractId,
        ixcManaged: panelUser.ixcManaged
      });
      panelUser.role = panelUser.role === "admin" ? "admin" : "viewer";
      panelUser.groups = Array.from(new Set([...(panelUser.groups || []), ixcDefaultGroupId]));
      panelUser.cameras = Array.isArray(panelUser.cameras) ? panelUser.cameras : [];
      panelUser.active = active;
      panelUser.ixcManaged = true;
      panelUser.ixcClientId = client.id;
      panelUser.ixcContractId = contract.id;
      panelUser.ixcProductId = ixcProductId;
      panelUser.passwordHash = makeIxcPasswordHash(panelUser);
      const after = JSON.stringify({
        active: panelUser.active,
        groups: panelUser.groups,
        ixcClientId: panelUser.ixcClientId,
        ixcContractId: panelUser.ixcContractId,
        ixcManaged: panelUser.ixcManaged
      });
      if (before !== after) summary.updated++;
    }
  }
  for (const user of db.users.filter((item) => item.ixcManaged)) {
    if (!managedEmails.has(user.username.toLowerCase()) && user.active) {
      user.active = false;
      summary.disabled++;
    }
  }
  db.audit.unshift({ at: new Date().toISOString(), action: "ixc_sync", product: ixcProductName, ...summary, by: options.by || "scheduler" });
  await saveDb(db);
  return summary;
}

function msUntilNextIxcSync() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(ixcSyncHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleIxcSync() {
  if (!ixcEnabled()) return;
  setTimeout(async () => {
    try {
      await syncIxcUsers(await loadDb());
    } catch (error) {
      console.error("IXC sync failed", error.message || error);
    } finally {
      scheduleIxcSync();
    }
  }, msUntilNextIxcSync());
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, { userId, createdAt: Date.now() });
  return `${sid}.${sign(sid)}`;
}

function getSession(req) {
  const cookie = parseCookies(req).session;
  if (!cookie) return null;
  const [sid, sig] = cookie.split(".");
  if (!sid || sig !== sign(sid)) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > 12 * 60 * 60 * 1000) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function currentUser(req, db) {
  const session = getSession(req);
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId && user.active) || null;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    cameras: user.cameras,
    groups: user.groups || [],
    active: user.active
  };
}

function allowedCameras(user, db) {
  const cameras = db.cameras.filter((camera) => camera.enabled);
  if (user.role === "admin") return cameras;
  const allowedCameraIds = new Set(user.cameras || []);
  const allowedGroupIds = new Set(user.groups || []);
  return cameras.filter((camera) => allowedCameraIds.has(camera.id) || allowedGroupIds.has(camera.groupId));
}

function allowedGroups(user, db) {
  if (user.role === "admin") return db.groups;
  const visibleGroupIds = new Set(allowedCameras(user, db).map((camera) => camera.groupId));
  return db.groups.filter((group) => visibleGroupIds.has(group.id));
}

function isCameraAllowed(user, db, cameraId) {
  return allowedCameras(user, db).some((camera) => camera.id === cameraId);
}

function alarmBelongsToCamera(alarm, cameraId) {
  if (alarm.channel === null || alarm.channel === undefined) return false;
  const channel = Number(alarm.channel);
  return cameraId === `camera${channel + 1}` || cameraId === `camera${channel}`;
}

function alarmsForCameraPeriod(db, cameraId, start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return db.alarms
    .filter((alarm) => {
      const alarmMs = new Date(alarm.at).getTime();
      return Number.isFinite(alarmMs) && alarmMs >= startMs && alarmMs <= endMs && alarmBelongsToCamera(alarm, cameraId);
    })
    .slice(0, 100)
    .map((alarm) => ({
      id: alarm.id,
      at: alarm.at,
      type: alarm.type,
      active: alarm.active,
      channel: alarm.channel
    }));
}

function publicPlaybackUrl(cameraId, item) {
  const url = new URL("/get", playbackPublicUrl);
  url.searchParams.set("path", cameraId);
  url.searchParams.set("start", item.start);
  url.searchParams.set("duration", String(Math.min(Number(item.duration || 0), 300)));
  url.searchParams.set("format", "mp4");
  return url.toString();
}

async function addAlarmEvent(event) {
  const db = await loadDb();
  db.alarms.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event
  });
  db.alarms = db.alarms.slice(0, 500);
  await saveDb(db);
}

function sofiaHash(password) {
  const md5 = crypto.createHash("md5").update(password).digest();
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < md5.length; i += 2) out += chars[(md5[i] + md5[i + 1]) % 62];
  return out;
}

function parseAlarmPayload(body) {
  const name = body?.Name;
  const payload = name && body?.[name] !== undefined ? body[name] : body;
  let channel = null;
  let type = name || "AlarmInfo";
  let active = null;

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    channel = payload.Channel ?? payload.channel ?? payload.ChannelID ?? null;
    type = payload.Event || payload.Type || payload.Status || payload.Name || type;
    active = payload.Status ?? payload.State ?? payload.Enable ?? null;
  }

  return { type: String(type), channel, active, raw: body };
}

class DvripAlarmClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.session = 0;
    this.seq = 0;
    this.keepalive = null;
    this.reconnect = null;
  }

  start() {
    alarmState.startedAt = new Date().toISOString();
    this.connect();
  }

  connect() {
    clearTimeout(this.reconnect);
    this.socket = net.createConnection({ host: nvrHost, port: nvrPort });
    this.socket.setTimeout(30000);
    this.socket.on("connect", () => this.login());
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.closeAndReconnect(error.message));
    this.socket.on("timeout", () => this.closeAndReconnect("timeout"));
    this.socket.on("close", () => this.closeAndReconnect("closed"));
  }

  closeAndReconnect(error) {
    alarmState.connected = false;
    alarmState.lastError = error || "";
    clearInterval(this.keepalive);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.connect(), 10000);
  }

  send(msg, data = {}) {
    if (!this.socket) return;
    const payload = Buffer.from(`${JSON.stringify(data)}\n\0`, "utf8");
    const header = Buffer.alloc(20);
    header.writeUInt8(255, 0);
    header.writeUInt8(0, 1);
    header.writeUInt32LE(this.session, 4);
    header.writeUInt32LE(this.seq++, 8);
    header.writeUInt16LE(msg, 14);
    header.writeUInt32LE(payload.length, 16);
    this.socket.write(Buffer.concat([header, payload]));
  }

  login() {
    this.session = 0;
    this.seq = 0;
    this.send(1000, {
      EncryptType: "MD5",
      LoginType: "DVRIP-Web",
      PassWord: sofiaHash(nvrPassword),
      UserName: nvrUser
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 20) {
      const session = this.buffer.readUInt32LE(4);
      const seq = this.buffer.readUInt32LE(8);
      const msgid = this.buffer.readUInt16LE(14);
      const length = this.buffer.readUInt32LE(16);
      if (this.buffer.length < 20 + length) return;
      const payload = this.buffer.subarray(20, 20 + length);
      this.buffer = this.buffer.subarray(20 + length);
      this.handlePacket({ session, seq, msgid, payload });
    }
  }

  handlePacket(packet) {
    let body = null;
    try {
      body = JSON.parse(packet.payload.subarray(0, Math.max(0, packet.payload.length - 2)).toString("utf8"));
    } catch {
      body = { rawText: packet.payload.toString("utf8") };
    }

    if (packet.msgid === 1001 && body?.Ret === 100) {
      this.session = Number.parseInt(body.SessionID, 16);
      alarmState.connected = true;
      alarmState.lastError = "";
      this.send(1500, { Name: "", SessionID: `0x${this.session.toString(16).padStart(8, "0").toUpperCase()}` });
      clearInterval(this.keepalive);
      this.keepalive = setInterval(() => {
        this.send(1006, { Name: "KeepAlive", SessionID: `0x${this.session.toString(16).padStart(8, "0").toUpperCase()}` });
      }, 10000);
      return;
    }

    if (packet.msgid === 1504) {
      alarmState.lastEventAt = new Date().toISOString();
      addAlarmEvent(parseAlarmPayload(body)).catch((error) => {
        alarmState.lastError = error.message;
      });
    }
  }
}

class DvripRequestClient {
  constructor(readTimeoutMs = 12000) {
    this.socket = null;
    this.session = 0;
    this.seq = 0;
    this.readTimeoutMs = readTimeoutMs;
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    this.socket = net.createConnection({ host: nvrHost, port: nvrPort });
    this.socket.setTimeout(20000);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
      this.socket.once("timeout", () => reject(new Error("timeout")));
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }

  async readBytes(size, timeoutMs = this.readTimeoutMs) {
    while (this.buffer.length < size) {
      await new Promise((resolve, reject) => {
        const onData = (chunk) => {
          if (chunk && chunk.length > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
          cleanup(resolve);
        };
        const onClose = () => cleanup(() => reject(new Error("socket closed")));
        const onError = (error) => cleanup(() => reject(error));
        const onTimeout = () => cleanup(() => reject(new Error("timeout lendo dados do NVR")));
        const cleanup = (done) => {
          clearTimeout(timer);
          this.socket.off("data", onData);
          this.socket.off("close", onClose);
          this.socket.off("error", onError);
          done();
        };
        const timer = setTimeout(onTimeout, timeoutMs);
        this.socket.once("data", onData);
        this.socket.once("close", onClose);
        this.socket.once("error", onError);
      });
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  writePacket(msg, data = {}) {
    const payload = Buffer.from(`${JSON.stringify(data)}\n\0`, "utf8");
    const header = Buffer.alloc(20);
    header.writeUInt8(255, 0);
    header.writeUInt8(0, 1);
    header.writeUInt32LE(this.session, 4);
    header.writeUInt32LE(this.seq++, 8);
    header.writeUInt16LE(msg, 14);
    header.writeUInt32LE(payload.length, 16);
    this.socket.write(Buffer.concat([header, payload]));
  }

  async request(msg, data = {}) {
    this.writePacket(msg, data);
    const header = await this.readBytes(20);
    this.session = header.readUInt32LE(4);
    const msgid = header.readUInt16LE(14);
    const length = header.readUInt32LE(16);
    const payload = await this.readBytes(length);
    try {
      return { msgid, body: JSON.parse(payload.subarray(0, Math.max(0, payload.length - 2)).toString("utf8")) };
    } catch {
      return { msgid, body: payload };
    }
  }

  async login() {
    const reply = await this.request(1000, {
      EncryptType: "MD5",
      LoginType: "DVRIP-Web",
      PassWord: sofiaHash(nvrPassword),
      UserName: nvrUser
    });
    if (reply.body?.Ret !== 100) throw new Error("Login DVRIP falhou");
    this.session = Number.parseInt(reply.body.SessionID, 16);
  }
}

function nvrChannelFromCameraId(cameraId) {
  const match = /^camera(\d+)$/.exec(cameraId || "");
  if (!match) return null;
  return Number(match[1]) - 1;
}

function formatNvrDate(value) {
  return new Date(value).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ").slice(0, 19);
}

function nvrDateMs(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || "");
  const parsed = new Date(text.includes("T") ? text : text.replace(" ", "T") + "-03:00").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function nvrFileOverlaps(file, start, end) {
  const begin = nvrDateMs(file.BeginTime);
  const finish = nvrDateMs(file.EndTime);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return begin < endMs && finish > startMs;
}

function uniqueNvrFiles(files) {
  const map = new Map();
  for (const file of files) {
    const key = file.FileName || `${file.BeginTime}-${file.EndTime}`;
    if (!map.has(key)) map.set(key, file);
  }
  return [...map.values()].sort((a, b) => nvrDateMs(a.BeginTime) - nvrDateMs(b.BeginTime));
}

function encodeToken(data) {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

function decodeToken(token) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}

async function queryNvrFiles({ channel, start, end }) {
  const client = new DvripRequestClient(10000);
  try {
    await client.connect();
    await client.login();
    const reply = await client.request(1440, {
      Name: "OPFileQuery",
      OPFileQuery: {
        BeginTime: formatNvrDate(start),
        EndTime: formatNvrDate(end),
        Channel: channel,
        DriverTypeMask: "0x0000FFFF",
        StreamType: "0x00000000",
        Event: "*",
        Type: "*"
      },
      SessionID: `0x${client.session.toString(16).padStart(8, "0").toUpperCase()}`
    });
    if (reply.body?.Ret !== 100 || !Array.isArray(reply.body.OPFileQuery)) return [];
    return reply.body.OPFileQuery;
  } finally {
    client.close();
  }
}

function queryNvrFilesIsolated({ channel, start, end, timeoutMs = 20000, type = "*" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "nvr-query.mjs"), JSON.stringify({ channel, start, end, type })], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout buscando arquivos no NVR"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `busca NVR saiu com codigo ${code}`));
      try {
        resolve(JSON.parse(stdout || "[]"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function queryNvrFilesRobust({ channel, start, end }) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const marginMs = 5 * 60 * 1000;
  const durationMs = Math.max(0, endMs - startMs);

  if (durationMs <= 2 * 60 * 60 * 1000) {
    const files = [];
    const chunkMs = 5 * 60 * 1000;
    for (let chunkStart = startMs - marginMs; chunkStart < endMs + marginMs; chunkStart += chunkMs) {
      const chunkEnd = Math.min(chunkStart + chunkMs, endMs + marginMs);
      try {
        const chunkFiles = await queryNvrFilesIsolated({
          channel,
          start: new Date(chunkStart).toISOString(),
          end: new Date(chunkEnd).toISOString(),
          timeoutMs: 4500
        });
        files.push(...chunkFiles);
      } catch (error) {
        console.error("NVR short chunk query failed", new Date(chunkStart).toISOString(), error.message || error);
      }
    }
    return uniqueNvrFiles(files.filter((file) => nvrFileOverlaps(file, start, end)));
  }

  try {
    const files = await queryNvrFilesIsolated({ channel, start, end, timeoutMs: 9000 });
    const filtered = uniqueNvrFiles(files.filter((file) => nvrFileOverlaps(file, start, end)));
    if (filtered.length) return filtered;
  } catch (error) {
    console.error("NVR exact query failed, trying fallback", error.message || error);
  }

  const queryStart = new Date(startMs - marginMs).toISOString();
  const queryEnd = new Date(endMs + marginMs).toISOString();
  try {
    const files = await queryNvrFilesIsolated({ channel, start: queryStart, end: queryEnd, timeoutMs: 9000 });
    const filtered = uniqueNvrFiles(files.filter((file) => nvrFileOverlaps(file, start, end)));
    if (filtered.length || (endMs - startMs) > 2 * 60 * 60 * 1000) return filtered;
  } catch (error) {
    console.error("NVR margin query failed, trying chunks", error.message || error);
  }

  const files = [];
  const chunkMs = 10 * 60 * 1000;
  for (let chunkStart = startMs - marginMs; chunkStart < endMs + marginMs; chunkStart += chunkMs) {
    const chunkEnd = Math.min(chunkStart + chunkMs, endMs + marginMs);
    try {
      const chunkFiles = await queryNvrFilesIsolated({
        channel,
        start: new Date(chunkStart).toISOString(),
        end: new Date(chunkEnd).toISOString(),
        timeoutMs: 10000
      });
      files.push(...chunkFiles);
    } catch (error) {
      console.error("NVR chunk query failed", new Date(chunkStart).toISOString(), error.message || error);
    }
  }
  return uniqueNvrFiles(files.filter((file) => nvrFileOverlaps(file, start, end)));
}

async function streamNvrFile(res, file, options = {}) {
  const client = new DvripRequestClient();
  let playback = null;
  try {
    await client.connect();
    await client.login();
    playback = {
      Name: "OPPlayBack",
      OPPlayBack: {
        Action: "Claim",
        Parameter: {
          PlayMode: "ByName",
          FileName: file.FileName,
          Channel: file.channel || 0,
          StreamType: file.streamType || 0,
          Value: 0,
          TransMode: "TCP"
        },
        StartTime: file.BeginTime,
        EndTime: file.EndTime
      },
      SessionID: `0x${client.session.toString(16).padStart(8, "0").toUpperCase()}`
    };
    await client.request(1424, playback);
    playback.OPPlayBack.Action = "DownloadStart";
    client.writePacket(1420, playback);

    res.writeHead(200, {
      "Content-Type": options.contentType || "application/octet-stream",
      ...(options.inline ? {} : { "Content-Disposition": `attachment; filename="${path.basename(file.FileName).replace(/[^a-zA-Z0-9_.-]/g, "_")}"` })
    });

    while (!res.destroyed) {
      const header = await client.readBytes(20);
      const length = header.readUInt32LE(16);
      if (!length) break;
      const chunk = await client.readBytes(length);
      if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
    }
  } catch (error) {
    console.error("NVR stream failed", error.message || error);
    if (!res.headersSent) return send(res, 504, { error: "NVR nao enviou o arquivo direto. Use Carregar trecho selecionado." });
  } finally {
    if (playback) {
      playback.OPPlayBack.Action = "DownloadStop";
      try { client.writePacket(1420, playback); } catch {}
    }
    client.close();
    if (!res.destroyed) res.end();
  }
}

async function downloadNvrFileToPath(file, outputPath, maxBytes = maxNvrDownloadBytes, maxDurationMs = 45000) {
  const client = new DvripRequestClient();
  await client.connect();
  await client.login();
  const deadline = Date.now() + maxDurationMs;
  const playback = {
    Name: "OPPlayBack",
    OPPlayBack: {
      Action: "Claim",
      Parameter: {
        PlayMode: "ByName",
        FileName: file.FileName,
        Channel: file.channel || 0,
        StreamType: file.streamType || 0,
        Value: 0,
        TransMode: "TCP"
      },
      StartTime: file.BeginTime,
      EndTime: file.EndTime
    },
    SessionID: `0x${client.session.toString(16).padStart(8, "0").toUpperCase()}`
  };
  await client.request(1424, playback);
  playback.OPPlayBack.Action = "DownloadStart";
  client.writePacket(1420, playback);
  const chunks = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      if (Date.now() > deadline) throw new Error("Tempo limite baixando arquivo do NVR");
      const header = await client.readBytes(20, 5000);
      const length = header.readUInt32LE(16);
      if (!length) break;
      if (total + length > maxBytes) throw new Error("Arquivo NVR excede limite de cache");
      const chunk = await client.readBytes(length, 5000);
      chunks.push(chunk);
      total += chunk.length;
    }
    if (total > maxBytes) throw new Error("Arquivo NVR excede limite de cache");
    await writeFile(outputPath, Buffer.concat(chunks, total));
  } finally {
    playback.OPPlayBack.Action = "DownloadStop";
    try { client.writePacket(1420, playback); } catch {}
    client.close();
  }
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y",
      "-f", "h264",
      "-r", process.env.NVR_CLIP_FPS || "15",
      "-i", input,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (chunk) => { err += chunk.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => code === 0 ? resolve() : reject(new Error(err.slice(-1000) || `ffmpeg saiu com codigo ${code}`)));
  });
}

function nvrClipKey(file) {
  return crypto.createHash("sha1").update(JSON.stringify({ v: 2, f: file.FileName, b: file.BeginTime, e: file.EndTime })).digest("hex");
}

async function ensureNvrClip(file) {
  await mkdir(clipCacheDir, { recursive: true });
  const key = nvrClipKey(file);
  const rawPath = path.join(clipCacheDir, `${key}.h264`);
  const mp4Path = path.join(clipCacheDir, `${key}.mp4`);
  if (!existsSync(mp4Path)) {
    if (!existsSync(rawPath)) await downloadNvrFileToPath(file, rawPath);
    await runFfmpeg(rawPath, mp4Path);
  }
  return { key, mp4Path };
}

function publicNvrClipUrl(key) {
  return `/api/nvr-clip-file?key=${encodeURIComponent(key)}`;
}

function startNvrClipJob(file) {
  const key = nvrClipKey(file);
  const mp4Path = path.join(clipCacheDir, `${key}.mp4`);
  if (existsSync(mp4Path)) return { key, status: "ready", url: publicNvrClipUrl(key) };
  const statusPath = path.join(clipCacheDir, `${key}.json`);
  if (existsSync(statusPath)) {
    try {
      const cached = JSON.parse(readFileSync(statusPath, "utf8"));
      if (cached.status === "preparing") return { key, status: "preparing" };
      unlinkSync(statusPath);
    } catch {
      try { unlinkSync(statusPath); } catch {}
    }
  }
  const child = spawn(process.execPath, [path.join(__dirname, "nvr-clip-worker.mjs"), JSON.stringify({ file, key, clipCacheDir, maxBytes: maxNvrDownloadBytes })], {
    stdio: "ignore",
    detached: true,
    env: process.env
  });
  child.unref();
  return { key, status: "preparing" };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(__dirname, "public", safePath));
  if (!filePath.startsWith(path.join(__dirname, "public"))) return send(res, 403, "Forbidden");
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(file);
  } catch {
    send(res, 404, "Not found");
  }
}

function requireAdmin(user, res) {
  if (user.role !== "admin") {
    send(res, 403, { error: "Sem permissao" });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const db = await loadDb();
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      const user = db.users.find((item) => item.username === body.username && item.active);
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        db.audit.unshift({ at: new Date().toISOString(), action: "login_failed", username: body.username || "" });
        await saveDb(db);
        return send(res, 401, { error: "Usuario ou senha invalidos" });
      }
      db.audit.unshift({ at: new Date().toISOString(), action: "login", username: user.username });
      await saveDb(db);
      return send(res, 200, { user: sanitizeUser(user) }, {
        "Set-Cookie": `session=${createSession(user.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const session = getSession(req);
      if (session) sessions.delete(session.sid);
      return send(res, 200, { ok: true }, { "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    if (url.pathname.startsWith("/api/")) {
      const user = await currentUser(req, db);
      if (!user) return send(res, 401, { error: "Nao autenticado" });

      if (req.method === "GET" && url.pathname === "/api/me") {
        return send(res, 200, { user: sanitizeUser(user), cameras: allowedCameras(user, db).map(cameraWithUrls), groups: allowedGroups(user, db) });
      }

      if (req.method === "GET" && url.pathname === "/api/recordings") {
        const cameraId = url.searchParams.get("camera");
        if (!cameraId || !isCameraAllowed(user, db, cameraId)) return send(res, 403, { error: "Camera nao liberada" });
        const start = url.searchParams.get("start") || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const end = url.searchParams.get("end") || new Date().toISOString();
        const listUrl = new URL("/list", playbackInternalUrl);
        listUrl.searchParams.set("path", cameraId);
        listUrl.searchParams.set("start", start);
        listUrl.searchParams.set("end", end);
        let items = [];
        try {
          items = await fetchJsonWithTimeout(listUrl, 8000);
        } catch (error) {
          console.error("Local playback query failed", error);
          return send(res, 504, { error: "Gravacoes locais indisponiveis no momento. Tente novamente em alguns segundos." });
        }
        return send(res, 200, {
          recordings: items.map((item) => ({
            start: item.start,
            duration: item.duration,
            url: publicPlaybackUrl(cameraId, item)
          })),
          alarms: alarmsForCameraPeriod(db, cameraId, start, end)
        });
      }

      if (req.method === "GET" && url.pathname === "/api/nvr-recordings") {
        const cameraId = url.searchParams.get("camera");
        if (!cameraId || !isCameraAllowed(user, db, cameraId)) return send(res, 403, { error: "Camera nao liberada" });
        const channel = nvrChannelFromCameraId(cameraId);
        if (channel === null) return send(res, 400, { error: "Camera invalida" });
        const start = url.searchParams.get("start") || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const end = url.searchParams.get("end") || new Date().toISOString();
        let files = [];
        try {
          files = await queryNvrFilesRobust({ channel, start, end });
        } catch (error) {
          console.error("NVR file query failed", error);
          return send(res, 504, { error: "NVR nao respondeu a busca de gravacoes. Tente um intervalo menor ou novamente em alguns segundos." });
        }
        return send(res, 200, {
          files: files.map((file) => ({
            begin: file.BeginTime,
            end: file.EndTime,
            size: Number.parseInt(file.FileLength || "0", 16) * 1024,
            name: path.basename(file.FileName),
            token: encodeToken({ ...file, cameraId, channel, streamType: 0 })
          })),
          alarms: alarmsForCameraPeriod(db, cameraId, start, end)
        });
      }

      if (req.method === "GET" && url.pathname === "/api/nvr-download") {
        const token = url.searchParams.get("token");
        if (!token) return send(res, 400, { error: "Token ausente" });
        const file = decodeToken(token);
        if (!file.cameraId || !isCameraAllowed(user, db, file.cameraId)) return send(res, 403, { error: "Camera nao liberada" });
        const size = Number.parseInt(file.FileLength || "0", 16) * 1024;
        if (size > maxNvrDownloadBytes) {
          return send(res, 413, `Arquivo muito grande para download direto no painel (${Math.round(size / 1024 / 1024)} MB). Use um intervalo menor ou aguarde a conversao por trecho.`);
        }
        return streamNvrFile(res, file);
      }

      if (req.method === "GET" && url.pathname === "/api/nvr-clip") {
        const token = url.searchParams.get("token");
        if (!token) return send(res, 400, { error: "Token ausente" });
        const file = decodeToken(token);
        if (!file.cameraId || !isCameraAllowed(user, db, file.cameraId)) return send(res, 403, { error: "Camera nao liberada" });
        const size = Number.parseInt(file.FileLength || "0", 16) * 1024;
        if (size > maxNvrDownloadBytes) return send(res, 413, { error: "Trecho grande demais para player. Use arquivos menores." });
        return send(res, 202, startNvrClipJob(file));
      }

      if (req.method === "GET" && url.pathname === "/api/nvr-clip-status") {
        const key = url.searchParams.get("key");
        if (!/^[a-f0-9]{40}$/.test(key || "")) return send(res, 400, { error: "Chave invalida" });
        const mp4Path = path.join(clipCacheDir, `${key}.mp4`);
        if (existsSync(mp4Path)) return send(res, 200, { key, status: "ready", url: publicNvrClipUrl(key) });
        const statusPath = path.join(clipCacheDir, `${key}.json`);
        if (existsSync(statusPath)) {
          const status = JSON.parse(await readFile(statusPath, "utf8"));
          return send(res, status.status === "error" ? 500 : 202, { key, ...status });
        }
        const job = nvrClipJobs.get(key);
        if (!job) return send(res, 404, { error: "Trecho nao encontrado na fila" });
        return send(res, job.status === "error" ? 500 : 202, { key, ...job });
      }

      if (req.method === "GET" && url.pathname === "/api/nvr-clip-file") {
        const key = url.searchParams.get("key");
        if (!/^[a-f0-9]{40}$/.test(key || "")) return send(res, 400, "Chave invalida");
        const filePath = path.join(clipCacheDir, `${key}.mp4`);
        if (!existsSync(filePath)) return send(res, 404, "Clip nao encontrado");
        const file = await readFile(filePath);
        res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=3600" });
        return res.end(file);
      }

      if (req.method === "GET" && url.pathname === "/api/alarms") {
        const allowed = new Set(allowedCameras(user, db).map((camera) => camera.id));
        const alarms = db.alarms.filter((alarm) => {
          if (user.role === "admin") return true;
          if (alarm.channel === null || alarm.channel === undefined) return true;
          const channel = Number(alarm.channel);
          return allowed.has(`camera${channel + 1}`) || allowed.has(`camera${channel}`);
        }).slice(0, 100);
        return send(res, 200, { status: alarmState, alarms });
      }

      if (req.method === "GET" && url.pathname === "/api/admin") {
        if (!requireAdmin(user, res)) return;
        return send(res, 200, {
          users: db.users.map(sanitizeUser),
          cameras: db.cameras.map(cameraWithUrls),
          groups: db.groups,
          audit: db.audit.slice(0, 80),
          ixc: { enabled: ixcEnabled(), product: ixcProductName, groupId: ixcDefaultGroupId, syncHour: ixcSyncHour }
        });
      }

      if (req.method === "POST" && url.pathname === "/api/admin/ixc-sync") {
        if (!requireAdmin(user, res)) return;
        const summary = await syncIxcUsers(db, { by: user.username });
        return send(res, 200, { ok: true, summary });
      }

      if (req.method === "POST" && url.pathname === "/api/admin/users") {
        if (!requireAdmin(user, res)) return;
        const body = await readJson(req);
        if (!body.username || !body.password) return send(res, 400, { error: "Usuario e senha sao obrigatorios" });
        if (db.users.some((item) => item.username === body.username)) return send(res, 409, { error: "Usuario ja existe" });
        const cameras = Array.isArray(body.cameras) ? body.cameras.filter((id) => db.cameras.some((camera) => camera.id === id)) : [];
        const groups = Array.isArray(body.groups) ? body.groups.filter((id) => db.groups.some((group) => group.id === id)) : [];
        db.users.push({
          id: crypto.randomUUID(),
          username: String(body.username).trim(),
          passwordHash: hashPassword(String(body.password)),
          role: body.role === "admin" ? "admin" : "viewer",
          cameras,
          groups,
          active: true
        });
        db.audit.unshift({ at: new Date().toISOString(), action: "user_created", username: body.username, by: user.username });
        await saveDb(db);
        return send(res, 201, { ok: true });
      }

      if (req.method === "PUT" && url.pathname.startsWith("/api/admin/users/")) {
        if (!requireAdmin(user, res)) return;
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const target = db.users.find((item) => item.id === id);
        if (!target) return send(res, 404, { error: "Usuario nao encontrado" });
        const body = await readJson(req);
        if (typeof body.active === "boolean") target.active = body.active;
        if (body.role === "admin" || body.role === "viewer") target.role = body.role;
        if (Array.isArray(body.cameras)) target.cameras = body.cameras.filter((camId) => db.cameras.some((camera) => camera.id === camId));
        if (Array.isArray(body.groups)) target.groups = body.groups.filter((groupId) => db.groups.some((group) => group.id === groupId));
        if (body.password) target.passwordHash = hashPassword(String(body.password));
        db.audit.unshift({ at: new Date().toISOString(), action: "user_updated", username: target.username, by: user.username });
        await saveDb(db);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/admin/groups") {
        if (!requireAdmin(user, res)) return;
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name) return send(res, 400, { error: "Nome do grupo obrigatorio" });
        const id = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID();
        if (db.groups.some((group) => group.id === id)) return send(res, 409, { error: "Grupo ja existe" });
        db.groups.push({ id, name });
        db.audit.unshift({ at: new Date().toISOString(), action: "group_created", group: name, by: user.username });
        await saveDb(db);
        return send(res, 201, { ok: true });
      }

      if (req.method === "PUT" && url.pathname.startsWith("/api/admin/groups/")) {
        if (!requireAdmin(user, res)) return;
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const group = db.groups.find((item) => item.id === id);
        if (!group) return send(res, 404, { error: "Grupo nao encontrado" });
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name) return send(res, 400, { error: "Nome do grupo obrigatorio" });
        group.name = name;
        db.audit.unshift({ at: new Date().toISOString(), action: "group_updated", group: group.id, by: user.username });
        await saveDb(db);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/admin/cameras") {
        if (!requireAdmin(user, res)) return;
        const body = await readJson(req);
        const id = nextCameraId(db);
        const number = Number(id.replace("camera", ""));
        const groupId = db.groups.some((group) => group.id === body.groupId) ? body.groupId : (db.groups[0]?.id || "principal");
        const name = String(body.name || "").trim() || `Camera ${number}`;
        const sourceUrl = String(body.sourceUrl || "").trim();
        const sourceType = sourceUrl ? "rtmp_pull" : "rtmp_push";
        const newCamera = {
          id,
          name,
          groupId,
          sourceUrl,
          sourceType,
          webrtcUrl: `http://172.16.21.122:8889/${id}/`,
          hlsUrl: `http://172.16.21.122:8888/${id}/`,
          enabled: body.enabled === true
        };
        db.cameras.push(newCamera);
        db.audit.unshift({ at: new Date().toISOString(), action: "camera_created", camera: id, by: user.username });
        await saveDb(db);
        await syncMediaMtxCamera(newCamera);
        return send(res, 201, { ok: true, id });
      }

      if (req.method === "PUT" && url.pathname.startsWith("/api/admin/cameras/")) {
        if (!requireAdmin(user, res)) return;
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const camera = db.cameras.find((item) => item.id === id);
        if (!camera) return send(res, 404, { error: "Camera nao encontrada" });
        const body = await readJson(req);
        if (typeof body.name === "string" && body.name.trim()) camera.name = body.name.trim();
        if (typeof body.groupId === "string" && db.groups.some((group) => group.id === body.groupId)) camera.groupId = body.groupId;
        if (typeof body.enabled === "boolean") camera.enabled = body.enabled;
        if (typeof body.sourceType === "string" && body.sourceType.startsWith("rtmp")) {
          camera.sourceType = body.sourceType === "rtmp_pull" ? "rtmp_pull" : "rtmp_push";
        }
        if (typeof body.sourceUrl === "string" && String(camera.sourceType || "").startsWith("rtmp")) {
          camera.sourceUrl = body.sourceUrl.trim();
          if (camera.sourceUrl) camera.sourceType = "rtmp_pull";
        }
        db.audit.unshift({ at: new Date().toISOString(), action: "camera_updated", camera: camera.id, by: user.username });
        await saveDb(db);
        await syncMediaMtxCamera(camera);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: "API nao encontrada" });
    }

    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: "Erro interno" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Camera panel listening on ${port}`);
});

new DvripAlarmClient().start();
scheduleIxcSync();
setTimeout(async () => {
  await syncMediaMtxCameras(await loadDb());
}, 5000);
