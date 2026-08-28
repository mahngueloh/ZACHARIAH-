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
    const bundle = {};
    
    // Recursively walk through all files in authDir, preserving directory structure
    function walkDir(dir, relativeBase = "") {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
            
            if (entry.isDirectory()) {
                walkDir(fullPath, relativePath);
            } else {
                // Read any file (not just .json)
                const content = fs.readFileSync(fullPath, "utf8");
                bundle[relativePath] = content;
            }
        }
    }
    
    walkDir(authDir);
    
    if (Object.keys(bundle).length === 0) {
        throw new Error("No auth files found in " + authDir);
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
    
    // Restore files and their directory structure
    for (const [filePath, content] of Object.entries(bundle)) {
        const fullPath = path.join(authDir, filePath);
        const dir = path.dirname(fullPath);
        
        // Create directories if they don't exist
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(fullPath, content, "utf8");
    }
    return Object.keys(bundle).length;
}

module.exports = { encodeSession, decodeSession, PREFIX };
