/*
  server/utils.mjs
  ----------------
  Small helpers used by the HTTP server.
*/

export function contentType(filePath) {
    if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
    if (filePath.endsWith(".js"))   return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".css"))  return "text/css; charset=utf-8";
    if (filePath.endsWith(".svg"))  return "image/svg+xml";
    return "text/plain; charset=utf-8";
}

/**
 * Read and parse a JSON body from an incoming HTTP request.
 * Calls 'onOk(obj)' with the parsed object, or sends 400 if parsing fails.
 */
export function handleJson(req, res, onOk) {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
        try {
            const obj = JSON.parse(buf || "{}");
            onOk(obj);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "bad json" }));
        }
    });
}

/** Send JSON response with given status code and object payload. */
export function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}
