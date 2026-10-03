const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PREFIX = "MH~";
const SESSION_STORE = new Map(); // Store: sessionHash -> auth bundle

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
    
    // Generate a short 17-character hash
    const hash = crypto.randomBytes(12).toString("hex").substring(0, 17);
    
    // Store the bundle in memory
    SESSION_STORE.set(hash, bundle);
    
    // Return the short session ID (MH~ + 17 chars = ~20 chars total)
    return PREFIX + hash;
}

function decodeSession(sessionId, authDir) {
    if (!sessionId.startsWith(PREFIX)) {
        throw new Error("Not a valid MAHNGUELOH session ID (missing prefix)");
    }
    
    const hash = sessionId.slice(PREFIX.length);
    const bundle = SESSION_STORE.get(hash);
    
    if (!bundle) {
        throw new Error("Session not found or expired");
    }

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

module.exports = { encodeSession, decodeSession, PREFIX, SESSION_STORE };
