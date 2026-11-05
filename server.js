import express from "express";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { fileURLToPath } from "url";
import path from "path";

const { LIVEKIT_URL, LIVEKIT_API_KEY: K, LIVEKIT_API_SECRET: S, ADMIN_KEY, PORT = 3000 } = process.env;
if (!LIVEKIT_URL || !K || !S) {
  console.error("Missing LIVEKIT_URL, LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
  process.exit(1);
}
const svc = new RoomServiceClient(LIVEKIT_URL.replace(/^wss?:/, "https:"), K, S);
const CAP = 20, MAX_ROOMS = 50;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

// tiny per-IP rate limiter
const hits = new Map();
setInterval(() => hits.clear(), 60_000);
const ok = (req, limit) => { const n = (hits.get(req.ip + limit) || 0) + 1; hits.set(req.ip + limit, n); return n <= limit; };

async function counts() {
  const m = {};
  (await svc.listRooms()).forEach(r => { if (r.name.startsWith("club-")) m[r.name] = r.numParticipants; });
  return m;
}

app.get("/api/rooms", async (req, res) => {
  try {
    const m = await counts();
    const top = Math.max(1, ...Object.keys(m).map(k => +k.slice(5)));
    res.json(Array.from({ length: top }, (_, i) => ({ n: i + 1, count: m["club-" + (i + 1)] || 0, cap: CAP })));
  } catch (e) { res.status(500).json({ error: "Could not load rooms." }); }
});

app.post("/api/join", async (req, res) => {
  if (!ok(req, 20)) return res.status(429).json({ error: "Slow down and try again in a minute." });
  try {
    const name = String(req.body.name || "").trim().slice(0, 20);
    if (!name || req.body.adult !== true) return res.status(400).json({ error: "Nickname and 18+ confirmation required." });
    const m = await counts();
    let n = Number(req.body.room) || 0;
    if (n) { if ((m["club-" + n] || 0) >= CAP) return res.status(409).json({ error: "That room is full." }); }
    else { n = 1; while ((m["club-" + n] || 0) >= CAP && n < MAX_ROOMS) n++; }
    const room = "club-" + n;
    await svc.createRoom({ name: room, maxParticipants: CAP, emptyTimeout: 300 }).catch(() => {});
    const at = new AccessToken(K, S, { identity: name + "-" + Math.random().toString(36).slice(2, 7), name, ttl: "4h" });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), url: LIVEKIT_URL, room: n });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not join. Try again." }); }
});

const reports = [];
app.post("/api/report", (req, res) => {
  if (!ok(req, 10)) return res.status(429).json({ error: "Too many reports." });
  const r = { at: new Date().toISOString(), room: Number(req.body.room) || 0, identity: String(req.body.identity || "").slice(0, 40), name: String(req.body.name || "").slice(0, 20) };
  reports.push(r); if (reports.length > 500) reports.shift();
  console.log("REPORT", JSON.stringify(r));
  res.json({ ok: true });
});

app.get("/admin/reports", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).end();
  res.json(reports);
});
app.post("/admin/kick", async (req, res) => {
  if (!ADMIN_KEY || req.body.key !== ADMIN_KEY) return res.status(401).end();
  try { await svc.removeParticipant("club-" + Number(req.body.room), String(req.body.identity)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: "Kick failed." }); }
});

app.listen(PORT, () => console.log("Club is open on port " + PORT));
