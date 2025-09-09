import crypto from "node:crypto";

/** In-memory singleton state shared by the server. */
export const state = {
    round: null,
    players: new Map(),
    joinCounter: 0, // <— counts players for default names: "Player 1", "Player 2", ...
};

export function gameState() {
    if (!state.round) return "idle";
    return state.round.status;
}

export function publicRound() {
    if (!state.round) return null;
    return {
        id: state.round.id,
        prompt: state.round.prompt,
        status: state.round.status,
        submissionCount: state.round.submissions.size
    };
}

export function getLeaderboard() {
    return [...state.players.entries()]
        .map(([id, p]) => ({ id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
}

export function getPlayersOverview(includeWords = false) {
    const rows = [...state.players.entries()].map(([id, p]) => {
        const submitted = !!(state.round && state.round.submissions.has(id));
        const row = { id, name: p.name, score: p.score, submitted };
        if (includeWords && submitted) row.word = state.round.submissions.get(id);
        return row;
    });
    rows.sort((a, b) => b.score - a.score);
    return rows;
}

export function startRound(prompt) {
    state.round = {
        id: crypto.randomUUID(),
        prompt: prompt || "",
        status: "collecting",
        submissions: new Map()
    };
}

export function closeRound() {
    if (!state.round || state.round.status !== "collecting") return { results: [], leaderboard: getLeaderboard() };
    state.round.status = "revealed";

    const counts = {};
    for (const rawWord of state.round.submissions.values()) {
        const key = normalize(rawWord);
        counts[key] = (counts[key] || 0) + 1;
    }
    for (const [playerId, rawWord] of state.round.submissions.entries()) {
        const freq = counts[normalize(rawWord)] || 0;
        const pts = Math.max(freq - 1, 0);
        const player = state.players.get(playerId);
        if (player) player.score += pts;
    }

    const results = Object.entries(counts).map(([word, freq]) => ({
        word, freq, pointsPerPlayer: Math.max(freq - 1, 0)
    }));

    return { results, leaderboard: getLeaderboard() };
}

/** Reset to a fresh session: clear round AND players, reset join order. */
export function resetGame() {
    state.round = null;
    state.players.clear();      // <— clear players so it’s truly a fresh session
    state.joinCounter = 0;      // <— reset join numbering
    return { leaderboard: getLeaderboard() }; // empty
}

/**
 * Ensure a player exists. If not, create with:
 * - default name "Player N" using join order, unless caller provided desiredName
 */
export function ensurePlayer(playerId, desiredName) {
    if (!state.players.has(playerId)) {
        const name = desiredName ? sanitizeName(desiredName)
            : `Player ${++state.joinCounter}`; // <—
        state.players.set(playerId, { name, score: 0 });
        return { created: true, player: state.players.get(playerId) };
    }
    return { created: false, player: state.players.get(playerId) };
}

export function recordSubmission(playerId, rawWord) {
    if (!state.round || state.round.status !== "collecting") return false;
    state.round.submissions.set(playerId, rawWord);
    return true;
}

export function renamePlayer(playerId, newName) {
    const player = state.players.get(playerId);
    if (!player) return { name: null, changed: false };
    const clean = sanitizeName(newName);
    const changed = clean !== player.name;
    if (changed) player.name = clean;
    return { name: clean, changed };
}

export function normalize(word) {
    return String(word || "")
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\s+/g, " ");
}

export function sanitizeName(name) {
    let s = String(name ?? "");
    s = s.replace(/[\u0000-\u001F\u007F]/g, "");
    s = s.trim().replace(/\s+/g, " ");
    if (!s) s = "Player " + (++state.joinCounter); // fallback still uses numbering
    if (s.length > 24) s = s.slice(0, 24);
    return s;
}


export function removePlayer(playerId) {
    state.players.delete(playerId);
}