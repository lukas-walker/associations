/*
  server/state.mjs
  ----------------
  Pure game state and rules. This file contains NO networking or file I/O.
  It exposes functions to mutate and query the in-memory state. The server
  (index.mjs) calls these functions and handles HTTP/WS I/O separately.

  Data model (single-room):
  - state.round: null OR {
      id: string,
      prompt: string,
      status: 'collecting' | 'revealed',
      submissions: Map<playerId, rawWord>
    }
  - state.players: Map<playerId, { name: string, score: number }>
*/

import crypto from "node:crypto";

/** In-memory singleton state shared by the server. */
export const state = {
    round: null,
    players: new Map()
};

/** Compute coarse-grained game state for displays: 'idle' | 'collecting' | 'revealed' */
export function gameState() {
    if (!state.round) return "idle";
    return state.round.status; // 'collecting' | 'revealed'
}

/** Return a public (player-safe) shape of the current round for UI. */
export function publicRound() {
    if (!state.round) return null;
    return {
        id: state.round.id,
        prompt: state.round.prompt,
        status: state.round.status,
        submissionCount: state.round.submissions.size
    };
}

/** Return leaderboard sorted by score DESC. */
export function getLeaderboard() {
    return [...state.players.entries()]
        .map(([id, p]) => ({ id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
}

/**
 * Return an overview of players for the host.
 * includeWords=true => includes the raw submitted word if the player has submitted.
 */
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

/** Create a new round and clear any prior submissions. */
export function startRound(prompt) {
    state.round = {
        id: crypto.randomUUID(),
        prompt: prompt || "",
        status: "collecting",
        submissions: new Map()
    };
}

/**
 * Close the current round, tally points, update scores, and return
 * aggregated results for broadcast.
 *
 * Returns:
 *   {
 *     results: [{ word: normalized, freq: number, pointsPerPlayer: number }],
 *     leaderboard: [...]
 *   }
 */
export function closeRound() {
    if (!state.round || state.round.status !== "collecting") return { results: [], leaderboard: getLeaderboard() };

    state.round.status = "revealed";

    // 1) Count normalized words.
    const counts = {};
    for (const rawWord of state.round.submissions.values()) {
        const key = normalize(rawWord);
        counts[key] = (counts[key] || 0) + 1;
    }

    // 2) Assign points to each submitting player: (frequency - 1), not below 0.
    for (const [playerId, rawWord] of state.round.submissions.entries()) {
        const freq = counts[normalize(rawWord)] || 0;
        const pts = Math.max(freq - 1, 0);
        const player = state.players.get(playerId);
        if (player) player.score += pts;
    }

    // 3) Build results payload for UI (normalized keys keep it deterministic).
    const results = Object.entries(counts).map(([word, freq]) => ({
        word,
        freq,
        pointsPerPlayer: Math.max(freq - 1, 0)
    }));

    return { results, leaderboard: getLeaderboard() };
}

/** Reset the whole game: clear round and zero all player scores. */
export function resetGame() {
    state.round = null;
    for (const p of state.players.values()) p.score = 0;
    return { leaderboard: getLeaderboard() };
}

/** Ensure a player entry exists; create with a random name if missing. */
export function ensurePlayer(playerId) {
    if (!state.players.has(playerId)) {
        const randomName = "Player-" + crypto.randomBytes(2).toString("hex");
        state.players.set(playerId, { name: randomName, score: 0 });
        return { created: true, player: state.players.get(playerId) };
    }
    return { created: false, player: state.players.get(playerId) };
}

/** Record (or overwrite) a player's submission for the active round. */
export function recordSubmission(playerId, rawWord) {
    if (!state.round || state.round.status !== "collecting") return false;
    state.round.submissions.set(playerId, rawWord);
    return true;
}

/**
 * Rename a player; returns { name, changed } where 'name' is the canonical
 * sanitized value that should be reflected in the UI.
 */
export function renamePlayer(playerId, newName) {
    const player = state.players.get(playerId);
    if (!player) return { name: null, changed: false };
    const clean = sanitizeName(newName);
    const changed = clean !== player.name;
    if (changed) player.name = clean;
    return { name: clean, changed };
}

/** Normalization used for scoring/tallying (but not for raw host display). */
export function normalize(word) {
    return String(word || "")
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\s+/g, " ");
}

/** Sanitize display names: strip control chars, collapse whitespace, clamp length. */
export function sanitizeName(name) {
    let s = String(name ?? "");
    s = s.replace(/[\u0000-\u001F\u007F]/g, "");   // control chars
    s = s.trim().replace(/\s+/g, " ");             // collapse spaces
    if (!s) s = "Player-" + crypto.randomBytes(2).toString("hex");
    if (s.length > 24) s = s.slice(0, 24);
    return s;
}
