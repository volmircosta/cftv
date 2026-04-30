import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const { file, key, clipCacheDir, maxBytes } = JSON.parse(process.argv[2] || "{}");
const host = process.env.NVR_HOST || "192.168.10.76";
const port = Number(process.env.NVR_PORT || 34567);
const user = process.env.NVR_USER || "portalcom";
const password = process.env.NVR_PASSWORD || "p0r74lc0m";
const rawPath = path.join(clipCacheDir, `${key}.h264`);
const mp4Path = path.join(clipCacheDir, `${key}.mp4`);
const statusPath = path.join(clipCacheDir, `${key}.json`);
const downloadLimitMs = 180000;
const outputFrameRate = process.env.NVR_CLIP_FPS || "15";

async function status(data) {
  await mkdir(clipCacheDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify(data, null, 2));
}

function sofiaHash(value) {
  const md5 = crypto.createHash("md5").update(value).digest();
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < md5.length; i += 2) out += chars[(md5[i] + md5[i + 1]) % 62];
  return out;
}

class Client {
  constructor() {
    this.socket = null;
    this.session = 0;
    this.seq = 0;
    this.buffer = Buffer.alloc(0);
  }
  async connect() {
    this.socket = net.createConnection({ host, port });
    this.socket.setTimeout(8000);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
      this.socket.once("timeout", () => reject(new Error("timeout conectando ao NVR")));
    });
  }
  close() {
    if (this.socket) this.socket.destroy();
  }
  async readBytes(size, timeoutMs = 5000) {
    while (this.buffer.length < size) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => cleanup(() => reject(new Error("timeout lendo NVR"))), timeoutMs);
        const onData = (chunk) => {
          if (chunk && chunk.length > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
          cleanup(resolve);
        };
        const onClose = () => cleanup(() => reject(new Error("socket fechado")));
        const onError = (error) => cleanup(() => reject(error));
        const cleanup = (done) => {
          clearTimeout(timer);
          this.socket.off("data", onData);
          this.socket.off("close", onClose);
          this.socket.off("error", onError);
          done();
        };
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
    const header = await this.readBytes(20, 8000);
    this.session = header.readUInt32LE(4);
    const length = header.readUInt32LE(16);
    const payload = await this.readBytes(length, 8000);
    return JSON.parse(payload.subarray(0, Math.max(0, payload.length - 2)).toString("utf8"));
  }
  async login() {
    const reply = await this.request(1000, {
      EncryptType: "MD5",
      LoginType: "DVRIP-Web",
      PassWord: sofiaHash(password),
      UserName: user
    });
    if (reply?.Ret !== 100) throw new Error("Login DVRIP falhou");
    this.session = Number.parseInt(reply.SessionID, 16);
  }
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-f", "h264",
      "-r", outputFrameRate,
      "-i", input,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (chunk) => { err += chunk.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => code === 0 ? resolve() : reject(new Error(err.slice(-1200) || `ffmpeg saiu com codigo ${code}`)));
  });
}

async function download() {
  if (existsSync(rawPath)) return;
  const expectedBytes = Number.parseInt(file.FileLength || "0", 16) * 1024;
  if (!expectedBytes) throw new Error("NVR nao informou o tamanho do arquivo");
  if (expectedBytes > maxBytes) throw new Error("Arquivo NVR excede limite");
  const client = new Client();
  await client.connect();
  await client.login();
  const playback = {
    Name: "OPPlayBack",
    OPPlayBack: {
      Action: "Claim",
      Parameter: { PlayMode: "ByName", FileName: file.FileName, Channel: file.channel || 0, StreamType: file.streamType || 0, Value: 0, TransMode: "TCP" },
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
  const deadline = Date.now() + downloadLimitMs;
  let lastStatusAt = 0;
  try {
    while (total < expectedBytes) {
      if (Date.now() > deadline) throw new Error("Tempo limite baixando arquivo do NVR");
      const header = await client.readBytes(20);
      const length = header.readUInt32LE(16);
      if (!length) break;
      if (total + length > maxBytes) throw new Error("Arquivo NVR excede limite");
      if (length > expectedBytes - total + 1024 * 1024) throw new Error("NVR enviou bloco maior que o esperado");
      const chunk = await client.readBytes(length);
      chunks.push(chunk);
      total += chunk.length;
      if (Date.now() - lastStatusAt > 1000) {
        lastStatusAt = Date.now();
        await status({ status: "preparing", step: "download", downloaded: total, expected: expectedBytes, startedAt: new Date().toISOString() });
      }
    }
    if (total < expectedBytes) throw new Error(`Download incompleto do NVR (${total}/${expectedBytes} bytes)`);
    await writeFile(rawPath, Buffer.concat(chunks, total));
  } finally {
    playback.OPPlayBack.Action = "DownloadStop";
    try { client.writePacket(1420, playback); } catch {}
    client.close();
  }
}

try {
  const watchdog = setTimeout(async () => {
    await status({ status: "error", error: "Tempo limite preparando clip NVR", failedAt: new Date().toISOString() });
    process.exit(1);
  }, downloadLimitMs + 15000);
  await status({ status: "preparing", step: "download", startedAt: new Date().toISOString() });
  await download();
  await status({ status: "preparing", step: "convert", startedAt: new Date().toISOString() });
  if (!existsSync(mp4Path)) await runFfmpeg(rawPath, mp4Path);
  await status({ status: "ready", url: `/api/nvr-clip-file?key=${key}`, readyAt: new Date().toISOString() });
  clearTimeout(watchdog);
} catch (error) {
  await status({ status: "error", error: error.message || "Falha preparando clip NVR", failedAt: new Date().toISOString() });
  process.exit(1);
}
