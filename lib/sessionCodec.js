const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PREFIX = "MAHNGUELOH~";

/**
 * Reads every file in an auth_info folder (creds.json + app-state-sync /
 * pre-key / session files Baileys writes there), bundles them into one
 * JSON object, gzips it, and returns a single copy-pasteable string
 * prefixed with PREFIX so it's easy to recognise.
 */
function encodeSession(authDir) {
    const files = fs.readdirSync(authDir).filter(f => f.endsWith(".json"));
    const bundle = {};
    for (const f of files) {
        bundle[f] = fs.readFileSync(path.join(authDir, f), "utf8");
    }
    const json = JSON.stringify(bundle);
    const gz = zlib.gzipSync(json);
    return PREFIX + gz.toString("base64");
}

/**
 * Reverses encodeSession(): takes the session ID string, decodes it,
 * and writes every file back out into authDir (creating it if needed).
 */
function decodeSession(sessionId, authDir) {
    if (!sessionId.startsWith(PREFIX)) {
        throw new Error("Not a valid MAHNGUELOH session ID (missing prefix)");
    }
    const b64 = sessionId.slice(PREFIX.length);
    const gz = Buffer.from(b64, "base64");
    const json = zlib.gunzipSync(gz).toString("utf8");
    const bundle = JSON.parse(json);

    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    for (const [filename, content] of Object.entries(bundle)) {
        fs.writeFileSync(path.join(authDir, filename), content, "utf8");
    }
    return Object.keys(bundle).length;
}

module.exports = { encodeSession, decodeSession, PREFIX };
