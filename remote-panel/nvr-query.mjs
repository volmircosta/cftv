import crypto from "node:crypto";
import net from "node:net";

const params = JSON.parse(process.argv[2] || "{}");
const host = process.env.NVR_HOST || "192.168.10.76";
const port = Number(process.env.NVR_PORT || 34567);
const user = process.env.NVR_USER || "portalcom";
const password = process.env.NVR_PASSWORD || "p0r74lc0m";

function sofiaHash(value) {
  const md5 = crypto.createHash("md5").update(value).digest();
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < md5.length; i += 2) out += chars[(md5[i] + md5[i + 1]) % 62];
  return out;
}

function formatNvrDate(value) {
  return new Date(value).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ").slice(0, 19);
}

class Client {
  constructor() {
    this.socket = null;
    this.session = 0;
    this.seq = 0;
  }

  async connect() {
    this.socket = net.createConnection({ host, port });
    this.socket.setTimeout(12000);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
      this.socket.once("timeout", () => reject(new Error("timeout conectando ao NVR")));
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }

  async readBytes(size) {
    const chunks = [];
    let total = 0;
    while (total < size) {
      const chunk = this.socket.read(size - total);
      if (chunk) {
        chunks.push(chunk);
        total += chunk.length;
        continue;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => cleanup(() => reject(new Error("timeout lendo NVR"))), 12000);
        const onReadable = () => cleanup(resolve);
        const onClose = () => cleanup(() => reject(new Error("socket fechado")));
        const onError = (error) => cleanup(() => reject(error));
        const cleanup = (done) => {
          clearTimeout(timer);
          this.socket.off("readable", onReadable);
          this.socket.off("close", onClose);
          this.socket.off("error", onError);
          done();
        };
        this.socket.once("readable", onReadable);
        this.socket.once("close", onClose);
        this.socket.once("error", onError);
      });
    }
    return Buffer.concat(chunks, size);
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
    const length = header.readUInt32LE(16);
    const payload = await this.readBytes(length);
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

const client = new Client();
try {
  await client.connect();
  await client.login();
  const reply = await client.request(1440, {
    Name: "OPFileQuery",
    OPFileQuery: {
      BeginTime: formatNvrDate(params.start),
      EndTime: formatNvrDate(params.end),
      Channel: Number(params.channel),
      DriverTypeMask: "0x0000FFFF",
      StreamType: "0x00000000",
      Event: "*",
      Type: params.type || "*"
    },
    SessionID: `0x${client.session.toString(16).padStart(8, "0").toUpperCase()}`
  });
  process.stdout.write(JSON.stringify(Array.isArray(reply.OPFileQuery) ? reply.OPFileQuery : []));
} finally {
  client.close();
}
