import { $, escapeHtml, setStatePill, debounce } from "./common.js";

/* ---------- DOM: Screens ---------- */
const elWelcome   = $("welcome");
const elGame      = $("game");
const elJoin      = $("join");
const elNick      = $("nick");

/* ---------- DOM: Game UI ---------- */
const elState     = $("statePill");
const elName      = $("name");
const elPrompt    = $("prompt");
const elWord      = $("word");
const elForm      = $("form");
const elSubmitted = $("submitted");   // small “Submitted!” hint for the local player
const elRoundInfo = $("roundInfo");   // "Waiting for next round..."
const elLeaders   = $("leaders");     // leaderboard container (we render a table here)

/* ---------- WebSocket lifecycle (lazy connect) ---------- */
let ws = null;
let joined = false;
let myId = null;

const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

function newSocket() {
    const sock = new WebSocket(WS_URL);
    sock.addEventListener("message", onMessage);
    sock.addEventListener("close", () => { joined = false; myId = null; });
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

/* ---------- Client-side state for rendering ---------- */
let lastGameState = "idle";          // "idle" | "collecting" | "revealed"
let lastLeaderboard = [];            // [{ id, name, score }]
let lastPerPlayerRound = null;       // [{ id, name, submitted, word, pointsGained, totalScore }] (after reveal)
let lastSubmittedIds = new Set();    // live: playerIds who have submitted in the current round

/* ---------- Small UI helpers ---------- */
function showWelcome() {
    elWelcome.classList.remove("hidden");
    elGame.classList.add("hidden");
    joined = false;
    myId = null;

    elName.value = "";
    elWord.value = "";
    elWord.disabled = true;
    elSubmitted.classList.add("hidden");
    elRoundInfo.classList.add("hidden");
    elLeaders.innerHTML = "";
    elPrompt.textContent = "— waiting for host —";
}

function showGame() {
    elWelcome.classList.add("hidden");
    elGame.classList.remove("hidden");
}

function setPrompt(text) {
    elPrompt.textContent = text || "— waiting for host —";
}

/* Convert leaderboard-only into rows compatible with the table renderer */
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

/* ---------- Leaderboard Table Renderer ---------- */
/**
 * Renders a table with columns:
 * Name | ✓ | Word | +Pts | Total
 * - Your row is pinned at the top and labeled "(you)".
 * - Other rows sorted by Total desc.
 * - During collecting: ✓ comes from live `lastSubmittedIds`; Word/+Pts are blank/0.
 * - After reveal: uses `lastPerPlayerRound` to show Word/+Pts and ✓ based on submitted.
 */
function renderLeaderboardTable({ rows, gameState }) {
    lastGameState = gameState || lastGameState;

    const haveRoundCols = Array.isArray(rows) && rows.length && Object.prototype.hasOwnProperty.call(rows[0], "submitted");

    // Order: you first, then by Total desc
    let arr = (rows || []).slice();
    arr.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
    if (myId) {
        const youIdx = arr.findIndex(r => r.id === myId);
        if (youIdx > 0) {
            const [you] = arr.splice(youIdx, 1);
            arr.unshift(you);
        }
    }

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

        const name = escapeHtml(p.name || "");
        const youBadge = p.id === myId ? ' <span class="text-neutral-400">(you)</span>' : "";

        // ✓ source:
        // - revealed: from row.submitted
        // - collecting: from live lastSubmittedIds
        // - idle: nothing
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
      <td class="px-4 py-2">${name}${youBadge}</td>
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

/* ---------- WebSocket message handling ---------- */
function onMessage(ev) {
    const msg = JSON.parse(ev.data);
    if (msg.gameState) {
        lastGameState = msg.gameState;
        setStatePill(elState, msg.gameState);
    }

    /* Initial hello ack when joining */
    if (msg.type === "hello_ack") {
        joined = true;
        myId = msg.playerId;
        showGame();

        elName.value = msg.name || "";
        setPrompt(msg.round?.prompt);

        // Cache incoming snapshots
        lastLeaderboard = msg.leaderboard || [];
        lastSubmittedIds = new Set(msg.submittedIds || []);
        lastGameState = msg.gameState || lastGameState;

        // Round UI
        if (lastGameState === "collecting") {
            elWord.disabled = !!msg.alreadySubmitted;
            elSubmitted.classList.toggle("hidden", !msg.alreadySubmitted);
            elRoundInfo.classList.add("hidden");
        } else {
            elWord.disabled = true;
            elSubmitted.classList.add("hidden");
            elRoundInfo.classList.remove("hidden"); // show “Waiting for next round…”
        }

        // Render table (leaderboard-only rows at this point)
        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    /* Rename round-trip */
    if (msg.type === "rename_ack" && joined) {
        elName.value = msg.name;
    }

    /* Live leaderboard refresh (e.g., when a new player joins) */
    if (msg.type === "leaderboard" && joined) {
        lastLeaderboard = msg.leaderboard || [];
        if (msg.gameState) lastGameState = msg.gameState;

        // If we have a per-round snapshot (e.g., after a reveal),
        // refresh names & totals from the latest leaderboard.
        if (lastPerPlayerRound) {
            const byId = new Map(lastLeaderboard.map(p => [p.id, p])); // { id -> {id,name,score} }
            lastPerPlayerRound = lastPerPlayerRound.map(r => {
                const lb = byId.get(r.id);
                return lb
                    ? { ...r, name: lb.name, totalScore: lb.score ?? r.totalScore }
                    : r;
            });
        }

        const rows = lastPerPlayerRound ?? rowsFromLeaderboardOnly();
        renderLeaderboardTable({ rows, gameState: lastGameState });
    }


    /* Round starts */
    if (msg.type === "round_started" && joined) {
        lastGameState = "collecting";
        lastPerPlayerRound = null;
        lastSubmittedIds = new Set(); // clear ✓

        elSubmitted.classList.add("hidden");
        elRoundInfo.classList.add("hidden");
        elWord.value = "";
        elWord.disabled = false;
        setPrompt(msg.round.prompt);

        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    /* Your submission accepted */
    if (msg.type === "submit_ack" && joined) {
        elWord.disabled = true;
        elSubmitted.classList.remove("hidden");
    }

    /* Live who-has-submitted updates (✓ during collecting) */
    if (msg.type === "round_progress" && joined) {
        if (Array.isArray(msg.submittedIds)) {
            lastSubmittedIds = new Set(msg.submittedIds);
        }
        if (msg.gameState) lastGameState = msg.gameState;
        const rows = lastPerPlayerRound ?? rowsFromLeaderboardOnly();
        renderLeaderboardTable({ rows, gameState: lastGameState });
    }

    /* Round revealed: per-player details arrive */
    if (msg.type === "round_revealed" && joined) {
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

        elWord.disabled = true;
        elSubmitted.classList.add("hidden");
        elRoundInfo.classList.remove("hidden");

        renderLeaderboardTable({ rows: lastPerPlayerRound, gameState: lastGameState });
    }

    /* Game reset → back to welcome */
    if (msg.type === "game_reset") {
        lastGameState = "idle";
        lastLeaderboard = [];
        lastPerPlayerRound = null;
        lastSubmittedIds = new Set();
        showWelcome();
    }
}

/* ---------- Join ---------- */
elJoin.addEventListener("click", async () => {
    if (joined) return;
    const desiredName = elNick.value.trim() || undefined;

    try {
        await ensureOpenSocket();
        ws.send(JSON.stringify({ type: "hello", desiredName }));
    } catch (err) {
        console.error("Failed to open WebSocket:", err);
        alert("Could not connect. Please try again.");
    }
});

/* ---------- Name change (debounced) ---------- */
const sendRename = debounce(() => {
    if (!joined) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "rename", name: elName.value }));
}, 300);
elName?.addEventListener("input", sendRename);

/* ---------- Submit word ---------- */
elForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!joined) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (elWord.disabled) return;

    const word = elWord.value;
    if (!word.trim()) return;
    ws.send(JSON.stringify({ type: "submit", word }));
});

/* ---------- Cleanup ---------- */
window.addEventListener("beforeunload", () => {
    try { ws?.close(); } catch {}
});

/* Start on the welcome screen */
showWelcome();
