const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PREFIX = "MH~";
const SESSION_STORE = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function encodeSession(authDir) {
    const bundle = {};

    function walkDir(dir, relativeBase = "") {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

            if (entry.isDirectory()) {
                walkDir(fullPath, relativePath);
            } else {
                const content = fs.readFileSync(fullPath, "utf8");
                bundle[relativePath] = content;
            }
        }
    }

    walkDir(authDir);

    if (Object.keys(bundle).length === 0) {
        throw new Error("No auth files found in " + authDir);
    }

    const hash = crypto.randomBytes(32).toString("base64url").replace(/[-_]/g, "").slice(0, 47);
    const sessionId = PREFIX + hash;

    SESSION_STORE.set(sessionId, bundle);

    setTimeout(() => {
        if (SESSION_STORE.has(sessionId)) {
            SESSION_STORE.delete(sessionId);
        }
    }, SESSION_TTL_MS);

    return sessionId;
}

function decodeSession(sessionId, authDir) {
    if (!sessionId.startsWith(PREFIX)) {
        throw new Error("Not a valid MAHNGUELOH session ID (missing prefix)");
    }

    const bundle = SESSION_STORE.get(sessionId);
    if (!bundle) {
        throw new Error("Session not found or expired");
    }

    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    for (const [filePath, content] of Object.entries(bundle)) {
        const fullPath = path.join(authDir, filePath);
        const dir = path.dirname(fullPath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, content, "utf8");
    }

    return Object.keys(bundle).length;
}

module.exports = { encodeSession, decodeSession, PREFIX, SESSION_STORE };
