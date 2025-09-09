import { $, escapeHtml, setStatePill, debounce } from "./common.js";

/* ----- Screens ----- */
const elWelcome   = $("welcome");
const elGame      = $("game");
const elJoin      = $("join");
const elNick      = $("nick");

/* ----- Game UI ----- */
const elState     = $("statePill");
const elName      = $("name");
const elPrompt    = $("prompt");
const elWord      = $("word");
const elForm      = $("form");
const elSubmitted = $("submitted");
const elResults   = $("results");
const elWords     = $("words");
const elLeaders   = $("leaders");

/* ----- WebSocket lifecycle (lazy connect) ----- */
let ws = null;         // current socket instance
let joined = false;    // have we joined the game on this socket?

const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

function newSocket() {
    // Create a fresh socket and attach handlers once.
    const sock = new WebSocket(WS_URL);

    sock.addEventListener("message", onMessage);

    // If the socket closes for any reason, reflect it in local state.
    sock.addEventListener("close", () => {
        // Don't auto-reconnect here; we reconnect lazily on the next user action.
        joined = false;
    });

    return sock;
}

function ensureOpenSocket() {
    // If no socket, or it’s closing/closed → create a fresh one.
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        ws = newSocket();
    }
    // If it’s still CONNECTING, wait for it.
    if (ws.readyState === WebSocket.CONNECTING) {
        return waitForOpen(ws);
    }
    // If already OPEN, resolve immediately.
    if (ws.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }
    // Otherwise, wait for open.
    return waitForOpen(ws);
}

function waitForOpen(sock) {
    return new Promise((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onErr  = (e) => { cleanup(); reject(e); };
        function cleanup() {
            sock.removeEventListener("open", onOpen);
            sock.removeEventListener("error", onErr);
        }
        sock.addEventListener("open", onOpen);
        sock.addEventListener("error", onErr);
    });
}

/* ----- UI screens ----- */
function showWelcome() {
    elWelcome.classList.remove("hidden");
    elGame.classList.add("hidden");
    joined = false;

    // Clean per-round UI
    elName.value = "";
    elWord.value = "";
    elWord.disabled = true;
    elSubmitted.classList.add("hidden");
    elResults.classList.add("hidden");
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
function renderLeaders(list) {
    elLeaders.innerHTML = "";
    list.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = `flex justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2`;
        row.innerHTML = `<span class="text-neutral-300">${i+1}. ${escapeHtml(p.name)}</span><span class="font-semibold">${p.score}</span>`;
        elLeaders.appendChild(row);
    });
}
function renderResults(results) {
    elWords.innerHTML = "";
    results.slice().sort((a,b)=>b.freq - a.freq).forEach(r => {
        const row = document.createElement("div");
        row.className = "flex justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2";
        row.innerHTML = `<span class="font-mono">${escapeHtml(r.word)}</span>
                     <span>${r.freq} picked • +${r.pointsPerPlayer} each</span>`;
        elWords.appendChild(row);
    });
    elResults.classList.remove("hidden");
}

/* ----- Message handler (shared for all sockets we create) ----- */
function onMessage(ev) {
    const msg = JSON.parse(ev.data);

    if (msg.gameState) setStatePill(elState, msg.gameState);

    if (msg.type === "hello_ack") {
        joined = true;
        showGame();

        elName.value = msg.name || "";
        setPrompt(msg.round?.prompt);
        renderLeaders(msg.leaderboard || []);

        if (msg.gameState === "collecting") {
            elWord.disabled = !!msg.alreadySubmitted;
            elSubmitted.classList.toggle("hidden", !msg.alreadySubmitted);
        } else {
            elWord.disabled = true;
            elSubmitted.classList.add("hidden");
        }
        if (msg.gameState !== "revealed") elResults.classList.add("hidden");
    }

    if (msg.type === "rename_ack" && joined) {
        elName.value = msg.name;
    }

    if (msg.type === "leaderboard" && joined) {
        renderLeaders(msg.leaderboard || []);
    }

    if (msg.type === "round_started" && joined) {
        elResults.classList.add("hidden");
        elSubmitted.classList.add("hidden");
        elWord.value = "";
        elWord.disabled = false;
        setPrompt(msg.round.prompt);
    }

    if (msg.type === "submit_ack" && joined) {
        elWord.disabled = true;
        elSubmitted.classList.remove("hidden");
    }

    if (msg.type === "round_revealed" && joined) {
        elWord.disabled = true;
        elSubmitted.classList.add("hidden");
        renderResults(msg.results);
        renderLeaders(msg.leaderboard);
    }

    if (msg.type === "game_reset") {
        // Host reset → go back to welcome screen.
        showWelcome();
    }
}

/* ----- Join button: connect if needed, then send hello safely ----- */
elJoin.addEventListener("click", async () => {
    if (joined) return;
    const desiredName = elNick.value.trim() || undefined;

    try {
        await ensureOpenSocket(); // opens or waits for OPEN
        ws.send(JSON.stringify({ type: "hello", desiredName }));
        // joined will flip to true when we receive hello_ack
    } catch (err) {
        console.error("Failed to open WebSocket:", err);
        alert("Could not connect. Please try again.");
    }
});

/* ----- Name change (after join) ----- */
const sendRename = debounce(() => {
    if (!joined) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "rename", name: elName.value }));
}, 300);
elName?.addEventListener("input", sendRename);

/* ----- Submit word ----- */
elForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!joined) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (elWord.disabled) return;

    const word = elWord.value;
    if (!word.trim()) return;
    ws.send(JSON.stringify({ type: "submit", word }));
});

/* ----- Close socket explicitly on tab unload (optional hardening) ----- */
window.addEventListener("beforeunload", () => {
    try { ws?.close(); } catch {}
});

/* Start on the welcome screen */
showWelcome();
