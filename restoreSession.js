// restoreSession.js
// Usage: node restoreSession.js "MAHNGUELOH~<base64>"
//
// Decodes a session ID produced by the MAHNGUELOH MD SESSION pairing page
// and writes it into this bot's ./auth_info folder, so the bot can start
// already paired instead of asking for a fresh pairing code.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PREFIX = "MAHNGUELOH~";

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

const sessionId = process.argv[2];
if (!sessionId) {
    console.log("Usage: node restoreSession.js \"MAHNGUELOH~<base64>\"");
    process.exit(1);
}

const authDir = path.join(__dirname, "auth_info");

try {
    const count = decodeSession(sessionId, authDir);
    console.log(`✅ Restored ${count} session file(s) into ${authDir}`);
    console.log("You can now start the bot normally — it should connect already paired.");
} catch (e) {
    console.log("❌ Failed to restore session:", e.message);
    process.exit(1);
}
