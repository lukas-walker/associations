/*
  public/js/common.js
  -------------------
  Shared helpers for both host and player pages.
*/

/** Get element by ID (typed short-hand). */
export const $ = (id) => document.getElementById(id);

/** Escape HTML to avoid breaking layout when rendering user-provided strings. */
export function escapeHtml(s) {
    return (s ?? "").toString().replace(/[&<>"']/g, (m) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[m]);
}

/** Update the "state pill" to reflect 'idle' | 'collecting' | 'revealed'. */
export function setStatePill(el, state) {
    el.textContent = "State: " + (state === "idle" ? "Idle" : state === "collecting" ? "Active" : "Closed");
    el.className = "px-3 py-1 rounded-full text-sm font-semibold border " +
        (state === "idle" ?   "bg-neutral-800 border-neutral-700"
            : state === "collecting" ? "bg-emerald-600/20 border-emerald-600"
                : "bg-amber-600/20 border-amber-600");
}

/** Debounce helper to limit how often we send rename messages over WS. */
export function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
