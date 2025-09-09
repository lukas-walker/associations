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
    renamePlayer,
    removePlayer,
    normalize
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
            // Also clear round progress (no one has submitted yet)
            broadcastAll({
                type: "round_progress",
                submittedIds: [],
                gameState: gameState()
            });

            return sendJson(res, 200, { ok: true, round: publicRound(), gameState: gameState() });
        });
    }

    if (req.method === "POST" && req.url === "/api/host/close") {
        const { results, leaderboard, counts, submissions } = closeRound();

        // Build per-player round summary for ALL players
        const subMap = new Map(submissions); // playerId -> rawWord
        const perPlayerRound = [];
        for (const [id, p] of state.players.entries()) {
            const raw = subMap.get(id) || null;
            const submitted = raw != null;
            const pointsGained = submitted ? Math.max((counts[normalize(raw)] || 0) - 1, 0) : 0;
            perPlayerRound.push({
                id,
                name: p.name,
                submitted,
                word: submitted ? raw : "",
                pointsGained,
                totalScore: p.score
            });
        }

        // Public reveal to EVERYONE, containing per-player details
        broadcastAll({
            type: "round_revealed",
            gameState: gameState(),
            round: publicRound(),
            results,
            leaderboard,
            perPlayerRound
        });

        // Host overview refresh
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
            req.url === "/leaderboard" ? "/leaderboard.html" :
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
        if (isHost) {
            hostSockets.delete(ws);
        } else if (playerId) {
            // Player tab closed → remove player and notify everyone
            removePlayer(playerId);

            broadcastHosts({
                type: "players_overview",
                gameState: gameState(),
                players: getPlayersOverview(true)
            });
            broadcastAll({
                type: "leaderboard",
                leaderboard: getLeaderboard(),
                gameState: gameState()
            });
        }
    });

    ws.on("message", (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch { return; }

        /* ----- Initial handshake from client ----- */
        if (msg.type === "hello") {
            if (msg.role === "viewer") {
                const gs = gameState();
                const submittedIds = (state.round && gs === "collecting")
                    ? Array.from(state.round.submissions.keys())
                    : [];

                ws.__isHost = false;
                ws.__playerId = null;

                ws.send(JSON.stringify({
                    type: "viewer_hello_ack",
                    gameState: gs,
                    round: publicRound(),
                    leaderboard: getLeaderboard(),
                    submittedIds
                }));
                return;
            }

            // Host identifies itself with role: 'host'
            if (msg.role === "host") {
                isHost = true;
                hostSockets.add(ws);

                // Tag this socket so other parts of the server can detect hosts
                ws.__isHost = true;

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

            playerId = msg.playerId || cryptoRandomId();
            const { player } = ensurePlayer(playerId, msg.desiredName);

            // Tag this socket so other parts of the server can address this player directly
            ws.__isHost = false;
            ws.__playerId = playerId;

            const gs = gameState();
            const alreadySubmitted = !!(state.round && state.round.submissions.has(playerId));
            const submittedIds = (state.round && gs === "collecting")
                ? Array.from(state.round.submissions.keys())
                : [];

            // Acknowledge with the player snapshot + who has already submitted this round
            ws.send(JSON.stringify({
                type: "hello_ack",
                playerId,
                name: player.name,
                round: publicRound(),
                leaderboard: getLeaderboard(),
                alreadySubmitted,
                submittedIds,                   // <— NEW
                gameState: gs
            }));

            // Everyone gets a refreshed leaderboard (so new player appears immediately)
            broadcastAll({
                type: "leaderboard",
                leaderboard: getLeaderboard(),
                gameState: gs
            });

            // Keep existing broadcasts
            broadcastAll({ type: "submission_count", count: state.round?.submissions.size || 0, gameState: gs });
            broadcastHosts({ type: "players_overview", gameState: gs, players: getPlayersOverview(true) });
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
            const reason = validateAssociation(state.round?.prompt || "", raw);
            if (reason) {
                // Tell the player why we rejected it; do not record.
                ws.send(JSON.stringify({ type: "submit_reject", reason, gameState: gameState() }));
                return;
            }


            recordSubmission(playerId, raw);

            const gs = gameState();

            // Acknowledge to this player
            ws.send(JSON.stringify({ type: "submit_ack", ok: true, gameState: gs }));

            // Everyone: update count
            broadcastAll({ type: "submission_count", count: state.round.submissions.size, gameState: gs });

            // Everyone: who has submitted so far (for ✓ column)
            broadcastAll({
                type: "round_progress",
                submittedIds: Array.from(state.round.submissions.keys()),
                gameState: gs
            });

            // Hosts: detailed overview
            broadcastHosts({ type: "players_overview", gameState: gs, players: getPlayersOverview(true) });
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



/* ---------- Validation of Association ---------- */

function norm(s) {
    return (s || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .trim();
}

/**
 * Returns null if allowed; otherwise a human-readable reason string.
 * Heuristics:
 * 1) Block exact prompt match.
 * 2) If prompt has multiple tokens (space/underscore/hyphen), block candidates
 *    that equal any token (after normalization).
 * 3) If prompt is a single word, block candidates that are a prefix/suffix
 *    of the prompt with length >= 4 (captures Dach, Ziegel; allows Ziege, App).
 */
function validateAssociation(promptRaw, candidateRaw) {
    const prompt = norm(promptRaw);
    const cand = norm(candidateRaw);

    if (!cand) return "Bitte gib ein Wort ein.";

    // 1) exact match
    if (cand === prompt) {
        return "Das ist genau das Prompt-Wort.";
    }

    // split on spaces/underscore/hyphen
    const parts = prompt.split(/[\s\-_]+/).filter(Boolean);

    if (parts.length > 1) {
        // 2) multi-token prompt: block if cand matches any token
        if (parts.some(p => cand === p)) {
            return "Wähle nicht einfach einen Teil des Prompts.";
        }
        return null; // otherwise OK
    }

    // 3) single-word prompt: prefix/suffix rule (len ≥ 4)
    // e.g., Dachziegel: block "dach" (prefix) and "ziegel" (suffix)
    const minLen = 4;
    if (cand.length >= minLen) {
        if (prompt.startsWith(cand) || prompt.endsWith(cand)) {
            return "Zu nah am Prompt (Vorsilbe/Nachsuffix).";
        }
    }

    return null; // allowed
}