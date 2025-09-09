/*
  server/index.mjs
  ----------------
  Orchestrates HTTP + WebSocket servers, routes host APIs, and broadcasts
  messages. All game rules/state mutations live in server/state.mjs.

  Key flows:
  - Host (role: 'host') connects via WS → gets host_hello_ack + players_overview
  - Player connects via WS → ensurePlayer, hello_ack
  - Host HTTP actions: /api/host/start, /api/host/close, /api/host/reset
*/

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

import {
    state,
    gameState,
    publicRound,
    getLeaderboard,
    getPlayersOverview,
    startRound,
    closeRound,
    resetGame,
    ensurePlayer,
    recordSubmission,
    renamePlayer
} from "./state.mjs";

import { contentType, handleJson, sendJson } from "./utils.mjs";

/* ---------- Runtime configuration ---------- */
const PORT = process.env.PORT || 8080;

/* ---------- Track connected host sockets for host-only broadcasts ---------- */
const hostSockets = new Set();

/* ---------- Create HTTP server: static files + host API ---------- */
const server = http.createServer((req, res) => {
    // Host Control API (no auth by design; keep this private if deployed publicly)
    if (req.method === "POST" && req.url === "/api/host/start") {
        return handleJson(req, res, (body) => {
            if (!body?.prompt) return sendJson(res, 400, { error: "prompt required" });
            startRound(body.prompt);
            broadcastAll({
                type: "round_started",
                gameState: gameState(),
                round: publicRound()
            });
            broadcastHosts({
                type: "players_overview",
                gameState: gameState(),
                players: getPlayersOverview(true)
            });
            return sendJson(res, 200, { ok: true, round: publicRound(), gameState: gameState() });
        });
    }

    if (req.method === "POST" && req.url === "/api/host/close") {
        const { results, leaderboard } = closeRound();
        broadcastAll({
            type: "round_revealed",
            gameState: gameState(),
            round: publicRound(),
            results,
            leaderboard
        });
        broadcastHosts({
            type: "players_overview",
            gameState: gameState(),
            players: getPlayersOverview(true)
        });
        return sendJson(res, 200, { ok: true, gameState: gameState() });
    }

    if (req.method === "POST" && req.url === "/api/host/reset") {
        const { leaderboard } = resetGame();
        broadcastAll({
            type: "game_reset",
            gameState: gameState(), // 'idle'
            round: null,
            leaderboard
        });
        broadcastHosts({
            type: "players_overview",
            gameState: gameState(),
            players: getPlayersOverview(true)
        });
        return sendJson(res, 200, { ok: true, round: null, gameState: gameState() });
    }

    // Static files
    const urlPath =
        req.url === "/host" ? "/host.html" :
            req.url === "/"     ? "/index.html" :
                req.url;
    const filePath = path.join(process.cwd(), "public", decodeURIComponent(urlPath));
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404).end("Not found");
        } else {
            res.writeHead(200, { "Content-Type": contentType(filePath) }).end(data);
        }
    });
});

/* ---------- WebSocket server ---------- */
const wss = new WebSocketServer({ server });

/** Broadcast to ALL WS clients (players + hosts). */
function broadcastAll(msg) {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(json);
    }
}

/** Broadcast only to host sockets. */
function broadcastHosts(msg) {
    const json = JSON.stringify(msg);
    for (const ws of hostSockets) {
        if (ws.readyState === 1) ws.send(json);
    }
}

wss.on("connection", (ws) => {
    // Each WS connection may represent a host OR a player.
    let isHost = false;
    let playerId = null;

    ws.on("close", () => {
        // If a host tab disconnects, remove it from hostSockets.
        if (isHost) hostSockets.delete(ws);
    });

    ws.on("message", (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch { return; }

        /* ----- Initial handshake from client ----- */
        if (msg.type === "hello") {
            // Host identifies itself with role: 'host'
            if (msg.role === "host") {
                isHost = true;
                hostSockets.add(ws);

                // Respond with the current snapshot for the host.
                ws.send(JSON.stringify({
                    type: "host_hello_ack",
                    gameState: gameState(),
                    round: publicRound(),
                    leaderboard: getLeaderboard(),
                    submissionCount: state.round?.submissions.size || 0
                }));

                // Send the detailed players overview (includes raw submitted words).
                ws.send(JSON.stringify({
                    type: "players_overview",
                    gameState: gameState(),
                    players: getPlayersOverview(true)
                }));
                return;
            }

            // Otherwise it's a player (create on first join).
            playerId = msg.playerId || cryptoRandomId();
            const { player } = ensurePlayer(playerId);

            // Did this player already submit in the current round?
            const alreadySubmitted = !!(state.round && state.round.submissions.has(playerId));

            // Acknowledge with the player snapshot.
            ws.send(JSON.stringify({
                type: "hello_ack",
                playerId,
                name: player.name,
                round: publicRound(),
                leaderboard: getLeaderboard(),
                alreadySubmitted,
                gameState: gameState()
            }));

            // Sync submission count to everyone (nice for the host counter).
            broadcastAll({ type: "submission_count", count: state.round?.submissions.size || 0, gameState: gameState() });

            // Update hosts with the latest players overview.
            broadcastHosts({ type: "players_overview", gameState: gameState(), players: getPlayersOverview(true) });
            return;
        }

        /* ----- Player changed name ----- */
        if (msg.type === "rename" && playerId) {
            const { name, changed } = renamePlayer(playerId, msg.name);
            // Tell the player the canonical name (sanitized, cropped, etc.)
            ws.send(JSON.stringify({ type: "rename_ack", name }));
            if (changed) {
                // Everyone gets a refreshed leaderboard; hosts also get a full overview.
                broadcastAll({ type: "leaderboard", leaderboard: getLeaderboard(), gameState: gameState() });
                broadcastHosts({ type: "players_overview", gameState: gameState(), players: getPlayersOverview(true) });
            }
            return;
        }

        /* ----- Player submitted a word ----- */
        if (msg.type === "submit" && playerId && state.round && state.round.status === "collecting") {
            const raw = typeof msg.word === "string" ? msg.word : "";
            if (!raw.trim()) return;
            recordSubmission(playerId, raw);

            // Tell this player their submission was accepted (UI disables input).
            ws.send(JSON.stringify({ type: "submit_ack", ok: true, gameState: gameState() }));

            // Everyone sees the new submission count.
            broadcastAll({ type: "submission_count", count: state.round.submissions.size, gameState: gameState() });

            // Hosts see who/what has been submitted.
            broadcastHosts({ type: "players_overview", gameState: gameState(), players: getPlayersOverview(true) });
            return;
        }
    });
});

/* ---------- Utilities ---------- */
function cryptoRandomId() {
    // A minimal ID generator for playerId when client didn't have one cached.
    // Using crypto.randomUUID() would also work, but this is shorter.
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/* ---------- Start HTTP+WS server ---------- */
server.listen(PORT, () => {
    console.log("Server listening on " + PORT);
});
