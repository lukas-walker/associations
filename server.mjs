import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;

// ---------------- In-memory game state ----------------
const state = {
  round: null,           // { id, prompt, status: 'collecting'|'revealed', submissions: Map<playerId, rawWord> }
  players: new Map(),    // playerId -> { name, score }
};

// Track connected host sockets so we can send host-only data (e.g., per-player words).
const hostSockets = new Set();

/* ---------- Helpers ---------- */
function gameState() {
  if (!state.round) return "idle";
  return state.round.status; // 'collecting' | 'revealed'
}

function newRound(prompt) {
  state.round = {
    id: crypto.randomUUID(),
    prompt: prompt || "",
    status: "collecting",
    submissions: new Map(),
  };
  broadcast({
    type: "round_started",
    gameState: gameState(),
    round: publicRound(),
  });
  broadcastHost({
    type: "players_overview",
    gameState: gameState(),
    players: getPlayersOverview(true),
  });
}

function closeRound() {
  if (!state.round || state.round.status !== "collecting") return;
  state.round.status = "revealed";

  // tally (normalized)
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
    word, freq, pointsPerPlayer: Math.max(freq - 1, 0),
  }));

  const payload = {
    type: "round_revealed",
    gameState: gameState(),
    round: publicRound(),
    results,
    leaderboard: getLeaderboard(),
  };
  broadcast(payload);
  broadcastHost({
    type: "players_overview",
    gameState: gameState(),
    players: getPlayersOverview(true),
  });
}

function resetGame() {
  // clear round and scores
  state.round = null;
  for (const p of state.players.values()) p.score = 0;

  const payloadAll = {
    type: "game_reset",
    gameState: gameState(), // 'idle'
    round: null,
    leaderboard: getLeaderboard(),
  };
  broadcast(payloadAll);
  broadcastHost({
    type: "players_overview",
    gameState: gameState(),
    players: getPlayersOverview(true),
  });
}

function publicRound() {
  if (!state.round) return null;
  return {
    id: state.round.id,
    prompt: state.round.prompt,
    status: state.round.status,
    submissionCount: state.round.submissions.size,
  };
}

function getLeaderboard() {
  return [...state.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// Host overview with optional words
function getPlayersOverview(includeWords = false) {
  return [...state.players.entries()].map(([id, p]) => {
    const submitted = !!(state.round && state.round.submissions.has(id));
    const row = {
      id,
      name: p.name,
      score: p.score,
      submitted,
    };
    if (includeWords && submitted) {
      row.word = state.round.submissions.get(id);
    }
    return row;
  }).sort((a, b) => b.score - a.score);
}

function normalize(word) {
  return word.trim().toLowerCase().normalize("NFKD").replace(/\s+/g, " ");
}

function sanitizeName(name) {
  let s = (name ?? "").toString();
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  s = s.trim().replace(/\s+/g, " ");
  if (!s) s = "Player-" + crypto.randomBytes(2).toString("hex");
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

/* ---------- HTTP server (static + host API) ---------- */
const server = http.createServer((req, res) => {
  // Host actions
  if (req.method === "POST" && req.url === "/api/host/start") {
    return handleJson(req, res, (body) => {
      if (!body?.prompt) return send(res, 400, { error: "prompt required" });
      newRound(body.prompt);
      send(res, 200, { ok: true, round: publicRound(), gameState: gameState() });
    });
  }

  if (req.method === "POST" && req.url === "/api/host/close") {
    closeRound();
    return send(res, 200, { ok: true, gameState: gameState() });
  }

  if (req.method === "POST" && req.url === "/api/host/next") {
    return handleJson(req, res, (body) => {
      newRound(body?.prompt || "");
      send(res, 200, { ok: true, round: publicRound(), gameState: gameState() });
    });
  }

  if (req.method === "POST" && req.url === "/api/host/reset") {
    resetGame();
    return send(res, 200, { ok: true, round: null, gameState: gameState() });
  }

  // static files
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

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

function broadcastHost(msg) {
  const json = JSON.stringify(msg);
  for (const ws of hostSockets) {
    if (ws.readyState === 1) ws.send(json);
  }
}

wss.on("connection", (ws) => {
  let playerId = null;
  let isHost = false;

  ws.on("close", () => {
    if (isHost) hostSockets.delete(ws);
  });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // initial hello
    if (msg.type === "hello") {
      if (msg.role === "host") {
        isHost = true;
        hostSockets.add(ws);
        ws.send(JSON.stringify({
          type: "host_hello_ack",
          gameState: gameState(),
          round: publicRound(),
          leaderboard: getLeaderboard(),
          submissionCount: state.round?.submissions.size || 0,
        }));
        // also send initial players overview
        ws.send(JSON.stringify({
          type: "players_overview",
          gameState: gameState(),
          players: getPlayersOverview(true),
        }));
        return;
      }

      // Otherwise it's a player
      playerId = msg.playerId || crypto.randomUUID();
      if (!state.players.has(playerId)) {
        const randomName = "Player-" + crypto.randomBytes(2).toString("hex");
        state.players.set(playerId, { name: randomName, score: 0 });
      }
      const alreadySubmitted = !!(state.round && state.round.submissions.has(playerId));
      ws.send(JSON.stringify({
        type: "hello_ack",
        playerId,
        name: state.players.get(playerId).name,
        round: publicRound(),
        leaderboard: getLeaderboard(),
        alreadySubmitted,
        gameState: gameState(),
      }));
      // Sync counts to all
      broadcast({ type: "submission_count", count: state.round?.submissions.size || 0, gameState: gameState() });
      // Update hosts with players overview
      broadcastHost({ type: "players_overview", players: getPlayersOverview(true), gameState: gameState() });
      return;
    }

    // player rename
    if (msg.type === "rename" && playerId) {
      const p = state.players.get(playerId);
      if (!p) return;
      const newName = sanitizeName(msg.name);
      if (newName !== p.name) {
        p.name = newName;
        ws.send(JSON.stringify({ type: "rename_ack", name: newName }));
        // Everyone gets updated leaderboard; hosts also get detailed overview
        broadcast({ type: "leaderboard", leaderboard: getLeaderboard(), gameState: gameState() });
        broadcastHost({ type: "players_overview", players: getPlayersOverview(true), gameState: gameState() });
      } else {
        ws.send(JSON.stringify({ type: "rename_ack", name: newName }));
      }
      return;
    }

    // submit word
    if (msg.type === "submit" && state.round && state.round.status === "collecting" && playerId) {
      const word = typeof msg.word === "string" ? msg.word : "";
      if (!word.trim()) return;
      state.round.submissions.set(playerId, word);
      ws.send(JSON.stringify({ type: "submit_ack", ok: true, gameState: gameState() }));
      // counts to everyone
      broadcast({ type: "submission_count", count: state.round.submissions.size, gameState: gameState() });
      // hosts see who submitted and what
      broadcastHost({ type: "players_overview", players: getPlayersOverview(true), gameState: gameState() });
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log("Server listening on " + PORT);
});
