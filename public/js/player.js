/*
  public/js/player.js
  -------------------
  Player-side client code. Handles:
  - WebSocket connection and message handling
  - Name editing (debounced 'rename' messages)
  - Word submission and UI state toggles
  - Rendering leaderboard and results
*/

import { $, escapeHtml, setStatePill, debounce } from "./common.js";

/* ----- DOM elements we interact with frequently ----- */
const elState = $("statePill");
const elName  = $("name");
const elPrompt= $("prompt");
const elWord  = $("word");
const elForm  = $("form");
const elSubmitted = $("submitted");
const elResults   = $("results");
const elWords     = $("words");
const elLeaders   = $("leaders");

/* ----- Open WS connection to same host; auto-wss under HTTPS ----- */
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);

/*
  Identify the player:
  - We persist playerId locally so reloading keeps your identity and score.
*/
const savedId = localStorage.getItem("playerId");

/* ----- Connect and introduce ourselves to the server ----- */
ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", playerId: savedId }));
});

/* ----- Handle rename (debounced to 300ms) ----- */
const sendRename = debounce(() => {
    ws.send(JSON.stringify({ type: "rename", name: elName.value }));
}, 300);
elName.addEventListener("input", sendRename);

/* ----- Handle submission ----- */
elForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (elWord.disabled) return;            // already submitted or round not active
    const word = elWord.value;
    if (!word.trim()) return;               // empty submissions ignored
    ws.send(JSON.stringify({ type: "submit", word }));
});

/* ----- Render helpers ----- */
function setPrompt(text) {
    elPrompt.textContent = text || "— waiting for host —";
}
function renderLeaders(list) {
    const me = localStorage.getItem("playerId");
    elLeaders.innerHTML = "";
    list.forEach((p, i) => {
        const row = document.createElement("div");
        const mine = p.id === me ? "border-emerald-600" : "border-neutral-800";
        row.className = `flex justify-between rounded-xl border ${mine} bg-neutral-900 px-4 py-2`;
        row.innerHTML = `<span class="text-neutral-300">${i+1}. ${escapeHtml(p.name)}</span><span class="font-semibold">${p.score}</span>`;
        elLeaders.appendChild(row);
    });
}
function renderResults(results) {
    elWords.innerHTML = "";
    results
        .slice()
        .sort((a,b) => b.freq - a.freq)
        .forEach(r => {
            const row = document.createElement("div");
            row.className = "flex justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2";
            row.innerHTML = `<span class="font-mono">${escapeHtml(r.word)}</span>
                       <span>${r.freq} picked • +${r.pointsPerPlayer} each</span>`;
            elWords.appendChild(row);
        });
    elResults.classList.remove("hidden");
}

/* ----- Handle server messages ----- */
ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);

    // Many server messages include gameState for the state pill
    if (msg.gameState) setStatePill(elState, msg.gameState);

    if (msg.type === "hello_ack") {
        // Persist identity for future reloads
        if (!localStorage.getItem("playerId")) localStorage.setItem("playerId", msg.playerId);

        // Pre-fill editable name with the canonical server-side value
        elName.value = msg.name || "";

        // Sync prompt + leaderboard
        setPrompt(msg.round?.prompt);
        renderLeaders(msg.leaderboard || []);

        // Submission UI depends on game state + whether we already submitted
        if (msg.gameState === "collecting") {
            elWord.disabled = !!msg.alreadySubmitted;
            elSubmitted.classList.toggle("hidden", !msg.alreadySubmitted);
        } else {
            elWord.disabled = true;
            elSubmitted.classList.add("hidden");
        }

        // If we’re not in reveal state, hide old results
        if (msg.gameState !== "revealed") elResults.classList.add("hidden");
    }

    if (msg.type === "rename_ack") {
        // Reflect sanitized/canonical name
        elName.value = msg.name;
    }

    if (msg.type === "leaderboard") {
        renderLeaders(msg.leaderboard || []);
    }

    if (msg.type === "round_started") {
        // Reset per-round UI
        elResults.classList.add("hidden");
        elSubmitted.classList.add("hidden");
        elWord.value = "";
        elWord.disabled = false;
        setPrompt(msg.round.prompt);
    }

    if (msg.type === "submit_ack") {
        // Lock input and show status
        elWord.disabled = true;
        elSubmitted.classList.remove("hidden");
    }

    if (msg.type === "round_revealed") {
        // Disable inputs; show results + fresh leaderboard
        elWord.disabled = true;
        elSubmitted.classList.add("hidden");
        renderResults(msg.results);
        renderLeaders(msg.leaderboard);
    }

    if (msg.type === "game_reset") {
        // Return to idle state
        setPrompt(null);
        elWord.value = "";
        elWord.disabled = true;
        elSubmitted.classList.add("hidden");
        elResults.classList.add("hidden");
        renderLeaders(msg.leaderboard || []);
    }
});
