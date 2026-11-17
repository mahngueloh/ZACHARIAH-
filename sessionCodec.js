const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Self-contained, NEVER-EXPIRING session ID.
//
// The whole auth bundle is packed into the string itself (gzip + base64), so
// redeeming it needs no server, no network call, and has no time limit or
// one-time-use rule. This is what the bot's "MAHNGUELOH~" format expects.
//
// (The previous "MH~" short IDs only pointed at an in-memory copy on this
// server: 30-minute TTL, deleted on first use, gone whenever the server
// restarted — so every bot redeploy needed a brand-new pairing.)
const PREFIX = "MAHNGUELOH~";
const LEGACY_PREFIX = "MH~";

// WhatsApp text messages max out around 65,536 characters.
const MAX_ID_LENGTH = 60000;

// Legacy in-memory store, kept only so old MH~ links don't crash anything.
const SESSION_STORE = new Map();

function walk(dir, base = "", out = {}) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = base ? path.join(base, entry.name) : entry.name;
        if (entry.isDirectory()) walk(full, rel, out);
        else out[rel] = fs.readFileSync(full, "utf8");
    }
    return out;
}

function pack(bundle) {
    return PREFIX + zlib.gzipSync(JSON.stringify(bundle), { level: 9 }).toString("base64");
}

function encodeSession(authDir) {
    const all = walk(authDir);
    if (!all["creds.json"]) throw new Error("creds.json not found in " + authDir);

    // Fresh pairings write ~800 pre-key files that would make the ID far too
    // long to send. They are not needed to reconnect — Baileys uploads fresh
    // pre-keys on connect — so leave them out. creds.json is the identity.
    const bundle = {};
    for (const [file, content] of Object.entries(all)) {
        if (/(^|[\\/])pre-key-/.test(file)) continue;
        bundle[file] = content;
    }

    let id = pack(bundle);
    if (id.length > MAX_ID_LENGTH) id = pack({ "creds.json": all["creds.json"] });
    return id;
}

function decodeSession(sessionId, authDir) {
    if (!sessionId.startsWith(PREFIX)) {
        throw new Error("Not a valid MAHNGUELOH session ID (missing prefix)");
    }
    const bundle = JSON.parse(
        zlib.gunzipSync(Buffer.from(sessionId.slice(PREFIX.length), "base64")).toString("utf8")
    );
    for (const [filePath, content] of Object.entries(bundle)) {
        const full = path.join(authDir, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
    }
    return Object.keys(bundle).length;
}

module.exports = { encodeSession, decodeSession, PREFIX, LEGACY_PREFIX, SESSION_STORE };
