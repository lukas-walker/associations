/*
  public/js/host.js
  -----------------
  Host-side client code. Handles:
  - WebSocket connection with role 'host' (host is NOT counted as a player)
  - Starting/closing/next/reset round via HTTP endpoints
  - Random German noun helper (client-side list)
  - Live players overview: submitted?, raw word (during collection), score
*/

import { $, escapeHtml, setStatePill } from "./common.js";

/* ----- DOM shortcuts ----- */
const elState = $("statePill");
const elPrompt= $("prompt");
const elCount = $("count");
const elTBody = $("playersTbody");

/* ----- Host controls (HTTP endpoints) ----- */
const headers = { "Content-Type": "application/json" };

$("random").onclick = () => {
    elPrompt.value = randomGermanNoun();
};

let lastState = "idle"; // 'idle' | 'collecting' | 'revealed'

function setControlsForState(state) {
    lastState = state;
    // Toggle primary button label & color
    const btn = $("primary");
    if (state === "collecting") {
        btn.textContent = "Close & Reveal";
        btn.className = "rounded-xl px-4 py-2 bg-rose-500 text-black font-semibold hover:bg-rose-400";
        // lock prompt while round is active
        $("random").disabled = true;
        $("random").classList.add("opacity-60","cursor-not-allowed");
        $("prompt").disabled = true;
        $("prompt").classList.add("opacity-60");
    } else {
        btn.textContent = "Start Round";
        btn.className = "rounded-xl px-4 py-2 bg-blue-500 text-black font-semibold hover:bg-blue-400";
        $("random").disabled = false;
        $("random").classList.remove("opacity-60","cursor-not-allowed");
        $("prompt").disabled = false;
        $("prompt").classList.remove("opacity-60");
    }
}

// Primary action: start OR close depending on state
$("primary").onclick = async () => {
    if (lastState === "collecting") {
        await fetch("/api/host/close", { method: "POST", headers });
    } else {
        const prompt = $("prompt").value.trim();
        if (!prompt) return alert("Enter a prompt");
        await fetch("/api/host/start", { method: "POST", headers, body: JSON.stringify({ prompt }) });
    }
};

$("reset").onclick = async () => {
    if (!confirm("Reset game? This clears scores and the current round.")) return;
    await fetch("/api/host/reset", { method: "POST", headers });
    elPrompt.value = "";
    elCount.textContent = "0";
};

/* ----- Random German noun list (client-side for zero-latency) ----- */
const germanNouns = [
    "Apfel","Haus","Auto","Hund","Katze","Baum","Stadt","Fluss","Berg","Buch","Tisch","Stuhl","Fenster","Tür","Garten",
    "Wolke","Sonne","Mond","Stern","Wasser","Feuer","Erde","Luft","Zug","Strasse","Brücke","Schule","Computer","Telefon","Lampe",
    "Blume","Zahl","Zeit","Wort","Spiel","Musik","Film","Reise","Kaffee","Tee","Brot","Käse","Fisch","Vogel","Schnee","Regen","Wind","Schublade",
    "Erbse","Wäscheklammer","Backpapier","Becher","Regen","Restaurant","Schaufel","Schraubenzieher","Tomate","Feuerzeug","Frühstück",
    "Streichholz","Kinder","Stuhl","Butter","Glühbirne","Holz","Wein","Verlängerungskabel","Haferflocken","Uhr","Fernbedienung",
    "Backofen","Reis","Thermoskanne","Regen","Wasserkocher","Seilzug","Kleidung","Router","Eimer","Schlüsselbund","Schuh","Apfelmus",
    "Baum","Schraube","Schreibtisch","Brücke","Ofen","Kalenderblatt","Briefkasten","Bohrer","Hand","Besen","Tasche","Kissen","Deckel",
    "Laptop","Schokolade","Flughafen","Mixer"
];
function randomGermanNoun() {
    return germanNouns[Math.floor(Math.random() * germanNouns.length)];
}

/* ----- Render the players overview table (host-only) ----- */
function renderPlayersOverview(list) {
    elTBody.innerHTML = "";
    list.forEach((p, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td class="px-4 py-2 text-neutral-400">${i+1}</td>
      <td class="px-4 py-2">${escapeHtml(p.name)}</td>
      <td class="px-4 py-2">${p.submitted ? "✅" : "—"}</td>
      <td class="px-4 py-2 max-w-[280px] truncate" title="${p.word ? escapeHtml(p.word) : ""}">${p.word ? escapeHtml(p.word) : ""}</td>
      <td class="px-4 py-2 text-right font-semibold">${p.score}</td>
    `;
        elTBody.appendChild(tr);
    });
}

/* ----- WebSocket (host identifies with role: 'host') ----- */
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);

ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "host" }));
});

ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.gameState) {
        setStatePill(elState, msg.gameState);
        setControlsForState(msg.gameState); // <— add this line
    }

    if (msg.type === "host_hello_ack") {
        // Initial snapshot for host UI
        elCount.textContent = msg.submissionCount || 0;
        if (msg.round?.prompt) elPrompt.value = msg.round.prompt;
        // leaderboard arrives separately when needed
    }

    if (msg.type === "round_started") {
        elCount.textContent = msg.round.submissionCount || 0;
        elPrompt.value = msg.round.prompt || "";
    }

    if (msg.type === "submission_count") {
        elCount.textContent = msg.count;
    }

    if (msg.type === "players_overview") {
        renderPlayersOverview(msg.players || []);
    }

    if (msg.type === "round_revealed") {
        elCount.textContent = "0";
        // players_overview will arrive separately (scores updated)
    }

    if (msg.type === "game_reset") {
        elCount.textContent = "0";
        elPrompt.value = "";
        renderPlayersOverview([]);
    }
});
