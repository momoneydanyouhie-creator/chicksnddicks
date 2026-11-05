import express from "express";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const clean = v => (v || "").trim().replace(/^["']|["']$/g, "");
const LIVEKIT_URL = clean(process.env.LIVEKIT_URL);
const K = clean(process.env.LIVEKIT_API_KEY);
const S = clean(process.env.LIVEKIT_API_SECRET);
const ADMIN_KEY = clean(process.env.ADMIN_KEY);
const PORT = process.env.PORT || 3000;

const missing = [
  !LIVEKIT_URL && "LIVEKIT_URL",
  !K && "LIVEKIT_API_KEY",
  !S && "LIVEKIT_API_SECRET",
].filter(Boolean);
if (missing.length) {
  console.error("Missing environment variable(s): " + missing.join(", ") + ". Set them in Render > Environment.");
  process.exit(1);
}

const HTTP_URL = LIVEKIT_URL.replace(/^wss?:/, "https:");
const WS_URL = LIVEKIT_URL.replace(/^https?:/, "wss:");
const svc = new RoomServiceClient(HTTP_URL, K, S);

const CAP = 20, MAX_ROOMS = 50;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

// tiny per-IP rate limiter
const hits = new Map();
setInterval(() => hits.clear(), 60_000);
const ok = (req, limit, tag = "") => {
  const key = req.ip + ":" + tag + ":" + limit;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  return n <= limit;
};

const validRoom = n => Number.isInteger(n) && n >= 1 && n <= MAX_ROOMS;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const isAdmin = key => ADMIN_KEY && safeEqual(key, ADMIN_KEY);

async function counts() {
  const m = {};
  (await svc.listRooms()).forEach(r => {
    if (r.name.startsWith("club-")) m[r.name] = r.numParticipants;
  });
  return m;
}

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/rooms", async (req, res) => {
  try {
    const m = await counts();
    const nums = Object.keys(m).map(k => +k.slice(5)).filter(Number.isFinite);
    const top = Math.min(MAX_ROOMS, Math.max(1, ...nums));
    res.json(Array.from({ length: top }, (_, i) => ({ n: i + 1, count: m["club-" + (i + 1)] || 0, cap: CAP })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load rooms." });
  }
});

app.post("/api/join", async (req, res) => {
  if (!ok(req, 20, "join")) return res.status(429).json({ error: "Slow down and try again in a minute." });
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 20);
    if (!name || body.adult !== true) return res.status(400).json({ error: "Nickname and 18+ confirmation required." });

    const m = await counts();
    let n = Number(body.room) || 0;
    if (n) {
      if (!validRoom(n)) return res.status(400).json({ error: "Invalid room." });
      if ((m["club-" + n] || 0) >= CAP) return res.status(409).json({ error: "That room is full." });
    } else {
      n = 1;
      while ((m["club-" + n] || 0) >= CAP && n < MAX_ROOMS) n++;
      if ((m["club-" + n] || 0) >= CAP) return res.status(409).json({ error: "All rooms are full." });
    }

    const room = "club-" + n;
    await svc.createRoom({ name: room, maxParticipants: CAP, emptyTimeout: 300 }).catch(() => {});
    const at = new AccessToken(K, S, {
      identity: name + "-" + Math.random().toString(36).slice(2, 7),
      name,
      ttl: "4h",
    });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), url: WS_URL, room: n });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not join. Try again." });
  }
});

const reports = [];
app.post("/api/report", (req, res) => {
  if (!ok(req, 10, "report")) return res.status(429).json({ error: "Too many reports." });
  const body = req.body || {};
  const r = {
    at: new Date().toISOString(),
    room: Number(body.room) || 0,
    identity: String(body.identity || "").slice(0, 40),
    name: String(body.name || "").slice(0, 20),
  };
  reports.push(r);
  if (reports.length > 500) reports.shift();
  console.log("REPORT", JSON.stringify(r));
  res.json({ ok: true });
});

app.get("/admin/reports", (req, res) => {
  if (!ok(req, 30, "admin")) return res.status(429).end();
  if (!isAdmin(req.query.key)) return res.status(401).end();
  res.json(reports);
});

app.post("/admin/kick", async (req, res) => {
  if (!ok(req, 30, "admin")) return res.status(429).end();
  const body = req.body || {};
  if (!isAdmin(body.key)) return res.status(401).end();
  const n = Number(body.room);
  if (!validRoom(n)) return res.status(400).json({ error: "Invalid room." });
  try {
    await svc.removeParticipant("club-" + n, String(body.identity));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kick failed." });
  }
});

// malformed JSON and other errors
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

app.listen(PORT, "0.0.0.0", () => console.log("Club is open on port " + PORT));
