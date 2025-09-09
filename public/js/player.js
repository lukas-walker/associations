import { $, escapeHtml, setStatePill, debounce } from "./common.js";

/* ---------- DOM: Screens ---------- */
const elWelcome   = $("welcome");
const elGame      = $("game");
const elJoin      = $("join");
const elNick      = $("nick");

/* ---------- DOM: Top Bar ---------- */
const elState       = $("statePill");
const elNamePill    = $("namePill");
const elNameDisplay = $("nameDisplay");
const elNameEdit    = $("nameEdit");

/* ---------- DOM: Game UI ---------- */
const elPrompt    = $("prompt");
const elWord      = $("word");
const elForm      = $("form");
const elSubmitted = $("submitted");   // “Submitted!” hint for the local player
const elRoundInfo = $("roundInfo");   // "Waiting for next round…"
const elLeaders   = $("leaders");     // leaderboard container (we render a table here)
const elSubmitBtn = $("submitBtn");   // submit button
const elPromptCard = $("promptCard"); // promt card

/* ---------- DOM: Inline form error (for submit_reject) ---------- */
const elFormError = $("formError");
function showFormError(text) {
    if (!elFormError) return;
    elFormError.textContent = text || "...";
    elFormError.classList.toggle("hidden", !text);
}
// Clear error when typing again
elWord.addEventListener("input", () => showFormError(""));

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
let lastPerPlayerRound = null;       // [{ id, name, submitted, word, pointsGained, totalScore }]
let lastSubmittedIds = new Set();    // live: playerIds who submitted in current round

/* ---------- Small UI helpers ---------- */
function showWelcome() {
    elWelcome.classList.remove("hidden");
    elGame.classList.add("hidden");
    joined = false;
    myId = null;

    updateNameUI(""); // clears pill/display/editor
    elWord.value = "";
    elWord.disabled = true;
    elSubmitted.classList.add("hidden");
    elRoundInfo.classList.add("hidden");
    elLeaders.innerHTML = "";
    elPrompt.textContent = "";
    showFormError("");

    elWord.disabled = true;
    setSubmitEnabled(false);
    setPromptActive(false);
}

// change submit button from green to grey in closed round
function setSubmitEnabled(enabled) {
    if (!elSubmitBtn) return;
    elSubmitBtn.disabled = !enabled;
    if (enabled) {
        elSubmitBtn.classList.remove("bg-neutral-600", "text-neutral-400", "cursor-not-allowed");
        elSubmitBtn.classList.add("bg-emerald-600", "hover:bg-emerald-700", "text-white");
    } else {
        elSubmitBtn.classList.remove("bg-emerald-600", "hover:bg-emerald-700", "text-white");
        elSubmitBtn.classList.add("bg-neutral-600", "text-neutral-400", "cursor-not-allowed");
    }
}

// change color of prompt card to green when round active
function setPromptActive(active) {
    if (!elPromptCard) return;
    if (active) {
        elPromptCard.classList.remove("bg-neutral-900");
        elPromptCard.classList.add("bg-emerald-600", "border-emerald-700", "text-white");
    } else {
        elPromptCard.classList.remove("bg-emerald-600", "border-emerald-700", "text-white");
        elPromptCard.classList.add("bg-neutral-900", "border-neutral-800");
    }
}

function showGame() {
    elWelcome.classList.add("hidden");
    elGame.classList.remove("hidden");
}

function setPrompt(text) {
    elPrompt.textContent = text || "...";
}

/* ---------- Name pill: view/edit ---------- */
function updateNameUI(name) {
    const n = name || "—";
    elNameDisplay.textContent = n;
    if (document.activeElement !== elNameEdit) {
        elNameEdit.value = n;
    }
}

function enterNameEdit() {
    // Keep input in normal flow to avoid layout jump
    elNamePill.classList.add("hidden");
    elNameEdit.classList.remove("hidden");
    elNameEdit.focus();
    elNameEdit.select();
}

function exitNameEdit() {
    elNameEdit.classList.add("hidden");
    elNamePill.classList.remove("hidden");
}

function submitRename(newName) {
    if (!joined) { exitNameEdit(); return; }
    if (!ws || ws.readyState !== WebSocketOPEN) { // guard if connection dropped
        try { ws?.close(); } catch {}
        exitNameEdit();
        return;
    }
    ws.send(JSON.stringify({ type: "rename", name: newName }));
    // We’ll update UI from rename_ack (authoritative)
    exitNameEdit();
}

// Fix WebSocket readyState constant typo-proofing
const WebSocketOPEN = 1;

elNamePill.addEventListener("click", () => enterNameEdit());

elNameEdit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        submitRename(elNameEdit.value);
    } else if (e.key === "Escape") {
        e.preventDefault();
        exitNameEdit();
    }
});

elNameEdit.addEventListener("blur", () => {
    // Save on blur for convenience (same as hitting Enter)
    submitRename(elNameEdit.value);
});

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

        updateNameUI(msg.name || "");
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
            setSubmitEnabled(!msg.alreadySubmitted); // enabled unless this player already submitted
            setPromptActive(true);                   // prompt card green on active round
        } else {
            elWord.disabled = true;
            elSubmitted.classList.add("hidden");
            elRoundInfo.classList.remove("hidden"); // show “Waiting for next round…”
            setSubmitEnabled(false);
            setPromptActive(false);
        }

        // Render table (leaderboard-only rows at this point)
        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    /* Rename round-trip */
    if (msg.type === "rename_ack" && joined) {
        updateNameUI(msg.name || "");

        // If we have a per-round snapshot, refresh our row there too
        if (lastPerPlayerRound) {
            lastPerPlayerRound = lastPerPlayerRound.map(r => r.id === myId ? { ...r, name: msg.name || r.name } : r);
            renderLeaderboardTable({ rows: lastPerPlayerRound, gameState: lastGameState });
        } else {
            const rows = rowsFromLeaderboardOnly();
            renderLeaderboardTable({ rows, gameState: lastGameState });
        }
    }

    /* Live leaderboard refresh (e.g., new player joins, someone renames) */
    if (msg.type === "leaderboard" && joined) {
        lastLeaderboard = msg.leaderboard || [];
        if (msg.gameState) lastGameState = msg.gameState;

        // If we have a per-round snapshot, refresh names & totals from latest leaderboard
        if (lastPerPlayerRound) {
            const byId = new Map(lastLeaderboard.map(p => [p.id, p]));
            lastPerPlayerRound = lastPerPlayerRound.map(r => {
                const lb = byId.get(r.id);
                return lb ? { ...r, name: lb.name, totalScore: lb.score ?? r.totalScore } : r;
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
        showFormError("");

        elWord.disabled = false;
        setSubmitEnabled(true);
        setPromptActive(true);

        renderLeaderboardTable({ rows: rowsFromLeaderboardOnly(), gameState: lastGameState });
    }

    /* Your submission accepted */
    if (msg.type === "submit_ack" && joined) {
        elWord.disabled = true;
        elSubmitted.classList.remove("hidden");
        showFormError("");
    }

    /* Submission rejected (server-side validation) */
    if (msg.type === "submit_reject" && joined) {
        // Keep input enabled so they can fix it
        showFormError(msg.reason || "Eingabe nicht erlaubt.");
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
        showFormError("");

        elWord.disabled = true;
        setSubmitEnabled(false);
        setPromptActive(false);

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

/* ---------- Submit word ---------- */
elForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!joined) return;
    if (!ws || ws.readyState !== WebSocketOPEN) return;
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
