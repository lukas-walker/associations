import { $, escapeHtml, setStatePill } from "./common.js";

/* ---------- DOM ---------- */
const elState   = $("statePill");
const elLeaders = $("leaders");

/* ---------- WebSocket ---------- */
let ws = null;
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

function newSocket() {
    const sock = new WebSocket(WS_URL);
    sock.addEventListener("message", onMessage);
    return sock;
}
function ensureOpenSocket() {
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        ws = newSocket();
    }
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onErr  = (e) => { cleanup(); reject(e); };
        function cleanup() { ws.removeEventListener("open", onOpen); ws.removeEventListener("error", onErr); }
        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onErr);
    });
}

/* ---------- Client state ---------- */
let lastGameState = "idle";          // "idle" | "collecting" | "revealed"
let lastLeaderboard = [];            // [{ id, name, score }]
let lastPerPlayerRound = null;       // [{ id, name, submitted, word, pointsGained, totalScore }]
let lastSubmittedIds = new Set();    // live: who submitted this round

/* ---------- Helpers ---------- */
function rowsFromLeaderboardOnly() {
    return (lastLeaderboard || []).map(p => ({
        id: p.id,
        name: p.name,
        submitted: false,
        word: "",
        pointsGained: 0,
        totalScore: p.score || 0
    }));
}

/* Render the same table players see (without the "(you)" row pinning) */
function renderLeaderboardTable({ rows, gameState }) {
    lastGameState = gameState || lastGameState;

    const haveRoundCols = Array.isArray(rows) && rows.length && Object.prototype.hasOwnProperty.call(rows[0], "submitted");

    // Sort by Total desc
    const arr = (rows || []).slice().sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    const wrap = document.createElement("div");
    wrap.className = "overflow-x-auto rounded-2xl border border-neutral-800";
    const table = document.createElement("table");
    table.className = "w-full text-sm bg-neutral-900";
    table.innerHTML = `
    <thead class="bg-neutral-800 text-neutral-300">
      <tr>
        <th class="text-left px-4 py-2">Name</th>
        <th class="text-left px-4 py-2">✓</th>
        <th class="text-left px-4 py-2">Word</th>
        <th class="text-right px-4 py-2">+Pts</th>
        <th class="text-right px-4 py-2">Total</th>
      </tr>
    </thead>
    <tbody id="lbBody" class="divide-y divide-neutral-800"></tbody>
  `;
    wrap.appendChild(table);

    const tbody = table.querySelector("#lbBody");
    arr.forEach(p => {
        const tr = document.createElement("tr");

        // ✓ source:
        let submittedFlag = false;
        if (lastGameState === "revealed") {
            submittedFlag = haveRoundCols ? !!p.submitted : false;
        } else if (lastGameState === "collecting") {
            submittedFlag = lastSubmittedIds.has(p.id);
        }

        const showRoundCols = (lastGameState === "revealed" && haveRoundCols);
        const word = showRoundCols && p.submitted ? escapeHtml(p.word || "") : "";
        const pts  = showRoundCols ? (p.pointsGained || 0) : 0;
        const ptsClass = showRoundCols
            ? (pts > 0 ? "text-emerald-400" : "text-neutral-500")
            : "text-neutral-500";

        tr.innerHTML = `
      <td class="px-4 py-2">${escapeHtml(p.name || "")}</td>
      <td class="px-4 py-2">${submittedFlag ? "✅" : "—"}</td>
      <td class="px-4 py-2">${word}</td>
      <td class="px-4 py-2 text-right ${ptsClass}">${showRoundCols ? (pts > 0 ? `+${pts}` : "0") : "0"}</td>
      <td class="px-4 py-2 text-right font-semibold">${p.totalScore ?? 0}</td>
    `;
        tbody.appendChild(tr);
    });

    elLeaders.innerHTML = "";
    elLeaders.appendChild(wrap);
}

/* ---------- Message handling ---------- */
function onMessage(ev) {
    const msg = JSON.parse(ev.data);

    if (msg.gameState) {
        lastGameState = msg.gameState;
        setStatePill(elState, msg.gameState);
    }

    if (msg.type === "viewer_hello_ack") {
        lastGameState = msg.gameState || lastGameState;
        lastLeaderboard = msg.leaderboard || [];
        lastSubmittedIds = new Set(msg.submittedIds || []);
        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    if (msg.type === "leaderboard") {
        lastLeaderboard = msg.leaderboard || [];
        if (msg.gameState) lastGameState = msg.gameState;

        if (lastPerPlayerRound) {
            // refresh names & totals from latest leaderboard (after reveal)
            const byId = new Map(lastLeaderboard.map(p => [p.id, p]));
            lastPerPlayerRound = lastPerPlayerRound.map(r => {
                const lb = byId.get(r.id);
                return lb ? { ...r, name: lb.name, totalScore: lb.score ?? r.totalScore } : r;
            });
        }

        const rows = lastPerPlayerRound ?? rowsFromLeaderboardOnly();
        renderLeaderboardTable({ rows, gameState: lastGameState });
    }

    if (msg.type === "round_started") {
        lastGameState = "collecting";
        lastPerPlayerRound = null;
        lastSubmittedIds = new Set();
        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    if (msg.type === "round_progress") {
        if (Array.isArray(msg.submittedIds)) {
            lastSubmittedIds = new Set(msg.submittedIds);
        }
        if (msg.gameState) lastGameState = msg.gameState;
        const rows = lastPerPlayerRound ?? rowsFromLeaderboardOnly();
        renderLeaderboardTable({ rows, gameState: lastGameState });
    }

    if (msg.type === "round_revealed") {
        lastGameState = "revealed";
        lastLeaderboard = msg.leaderboard || [];
        lastPerPlayerRound = (msg.perPlayerRound || []).map(r => ({
            id: r.id,
            name: r.name,
            submitted: !!r.submitted,
            word: r.word || "",
            pointsGained: r.pointsGained || 0,
            totalScore: r.totalScore || 0
        }));
        renderLeaderboardTable({ rows: lastPerPlayerRound, gameState: lastGameState });
    }

    if (msg.type === "game_reset") {
        lastGameState = "idle";
        lastLeaderboard = [];
        lastPerPlayerRound = null;
        lastSubmittedIds = new Set();
        renderLeaderboardTable({ rows: [], gameState: lastGameState });
    }
}

/* ---------- Boot ---------- */
ensureOpenSocket().then(() => {
    ws.send(JSON.stringify({ type: "hello", role: "viewer" }));
}).catch(err => {
    console.error("WS connect failed:", err);
});
