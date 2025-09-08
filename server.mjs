import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;

// ---------------- In-memory game state ----------------
const state = {
  round: null,           // { id, prompt, status: 'collecting'|'revealed', submissions: Map<playerId, word> }
  players: new Map(),    // playerId -> { name, score }
};

function newRound(prompt) {
  state.round = {
    id: crypto.randomUUID(),
    prompt: prompt || "",
    status: "collecting",
    submissions: new Map()
  };
  broadcast({ type: "round_started", round: publicRound() });
}

function closeRound() {
  if (!state.round || state.round.status !== "collecting") return;
  state.round.status = "revealed";

  // tally
  const counts = {};
  for (const w of state.round.submissions.values()) {
    const key = normalize(w);
    counts[key] = (counts[key] || 0) + 1;
  }
  // award points
  for (const [pid, w] of state.round.submissions.entries()) {
    const c = counts[normalize(w)] || 0;
    const pts = Math.max(c - 1, 0);
    const p = state.players.get(pid);
    if (p) p.score += pts;
  }

  const results = Object.entries(counts).map(([word, freq]) => ({
    word, freq, pointsPerPlayer: Math.max(freq - 1, 0)
  }));

  broadcast({
    type: "round_revealed",
    round: publicRound(),
    results,
    leaderboard: getLeaderboard()
  });
}

function publicRound() {
  if (!state.round) return null;
  return {
    id: state.round.id,
    prompt: state.round.prompt,
    status: state.round.status,
    submissionCount: state.round.submissions.size
  };
}

function getLeaderboard() {
  return [...state.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function normalize(word) {
  return word.trim().toLowerCase().normalize("NFKD").replace(/\s+/g, " ");
}

// ---------------- Static file server ----------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/host/start") {
    return handleJson(req, res, (body) => {
      if (!body?.prompt) return send(res, 400, { error: "prompt required" });
      newRound(body.prompt);
      send(res, 200, { ok: true, round: publicRound() });
    });
  }

  if (req.method === "POST" && req.url === "/api/host/close") {
    closeRound();
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/api/host/next") {
    return handleJson(req, res, (body) => {
      newRound(body?.prompt || "");
      send(res, 200, { ok: true, round: publicRound() });
    });
  }

  // static
  const p = req.url === "/host" ? "/host.html"
        : req.url === "/" ? "/index.html"
        : req.url;
  const filePath = path.join(process.cwd(), "public", decodeURIComponent(p));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
    } else {
      res.writeHead(200, { "Content-Type": contentType(filePath) }).end(data);
    }
  });
});

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function handleJson(req, res, fn) {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    try { fn(JSON.parse(b || "{}")); }
    catch { send(res, 400, { error: "bad json" }); }
  });
}

function contentType(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
}

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

wss.on("connection", (ws, req) => {
  let playerId = null;
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "hello") {
      playerId = msg.playerId || crypto.randomUUID();
      if (!state.players.has(playerId)) {
        const randomName = "Player-" + crypto.randomBytes(2).toString("hex");
        state.players.set(playerId, { name: randomName, score: 0 });
      }
      ws.send(JSON.stringify({
        type: "hello_ack",
        playerId,
        name: state.players.get(playerId).name,
        round: publicRound(),
        leaderboard: getLeaderboard()
      }));
      broadcast({ type: "submission_count", count: state.round?.submissions.size || 0 });
      return;
    }

    if (msg.type === "submit" && state.round && state.round.status === "collecting" && playerId) {
      const word = typeof msg.word === "string" ? msg.word : "";
      if (!word.trim()) return;
      state.round.submissions.set(playerId, word);
      ws.send(JSON.stringify({ type: "submit_ack", ok: true }));
      broadcast({ type: "submission_count", count: state.round.submissions.size });
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log("Server listening on " + PORT);
});
