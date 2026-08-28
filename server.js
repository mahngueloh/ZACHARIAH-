const path = require("path");
const fs = require("fs");
const express = require("express");
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    delay,
} = require("@whiskeysockets/baileys");

// FIXED: was "./lib/sessionCodec" — file is in root, not lib/
const { encodeSession } = require("./sessionCodec");

const PORT = process.env.PORT || 4000;
const SITE_NAME = process.env.SITE_NAME || "MAHNGUELOH MD SESSION";
const TEMP_ROOT = path.join(__dirname, "temp_sessions");
const JOB_FILE = path.join(__dirname, "jobs.json");

if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory job tracker with disk backup for Render free-tier restarts
const jobs = new Map();
const activeSockets = new Set(); // prevents duplicate socket starts

function loadJobs() {
    if (!fs.existsSync(JOB_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
        for (const [k, v] of Object.entries(data)) jobs.set(k, v);
        console.log("[jobs] loaded", jobs.size, "job(s) from disk");
    } catch (e) {
        console.error("[jobs] failed to load:", e.message);
    }
}

function saveJobs() {
    try {
        const obj = Object.fromEntries(jobs);
        fs.writeFileSync(JOB_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error("[jobs] failed to save:", e.message);
    }
}

function cleanupJob(jobId, authDir) {
    jobs.delete(jobId);
    saveJobs();
    fs.rm(authDir, { recursive: true, force: true }, () => {});
}

// Clean up stale temp sessions older than 24h on startup
try {
    const dirs = fs.readdirSync(TEMP_ROOT);
    for (const dir of dirs) {
        const fullPath = path.join(TEMP_ROOT, dir);
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtime.getTime() > 24 * 60 * 60 * 1000) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        }
    }
} catch {}

// Restore jobs that survived a Render restart
loadJobs();

app.get("/api/site-name", (req, res) => {
    res.json({ name: SITE_NAME });
});

app.post("/api/pair", async (req, res) => {
    const number = String(req.body.number || "").replace(/[^0-9]/g, "");
    if (!number || number.length < 8) {
        return res.status(400).json({ error: "Enter a valid phone number with country code, digits only." });
    }

    const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const authDir = path.join(TEMP_ROOT, jobId);
    fs.mkdirSync(authDir, { recursive: true });

    jobs.set(jobId, { status: "starting", code: null, sessionId: null, error: null, retries: 0 });
    saveJobs();

    res.json({ jobId });

    const MAX_RETRIES = 6;

    async function startSocket() {
        if (activeSockets.has(jobId)) {
            console.log("[pair] socket already starting for", jobId, "- skipping duplicate");
            return;
        }
        activeSockets.add(jobId);

        const job = jobs.get(jobId);
        if (!job) {
            activeSockets.delete(jobId);
            return;
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            // CHANGED from "silent" to "warn" so you can see problems in Render logs
            const logger = pino({ level: "warn" });

            let version;
            try {
                const v = await Promise.race([
                    fetchLatestBaileysVersion(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
                ]);
                version = v.version;
            } catch {
                version = [2, 3000, 1015920675];
            }

            const needsPairing = !state.creds.registered;

            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                browser: Browsers.ubuntu("Chrome"),
                mobile: false,
                printQRInTerminal: false,
                logger,
                syncFullHistory: false,
                connectTimeoutMs: 60_000,
                keepAliveIntervalMs: 30_000,
                retryRequestDelayMs: 3_000,
                markOnlineOnConnect: false,
                getMessage: async () => undefined,
            });

            sock.ev.on("creds.update", saveCreds);

            let pairingRequested = false;

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                const j = jobs.get(jobId);
                if (!j) return;

                if (qr && needsPairing && !pairingRequested && !j.code) {
                    pairingRequested = true;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const code = await sock.requestPairingCode(number);
                            j.status = "code_ready";
                            j.code = code?.replace(/\W/g, "").match(/.{1,4}/g)?.join("-") || code;
                            saveJobs();
                            console.log("[pair] code ready for", jobId, ":", j.code);
                            break;
                        } catch (e) {
                            console.error("[pair] requestPairingCode attempt", attempt, "failed:", e.message);
                            if (attempt === 3) {
                                j.status = "error";
                                j.error = "Failed to request pairing code: " + e.message;
                                saveJobs();
                                cleanupJob(jobId, authDir);
                                activeSockets.delete(jobId);
                                return;
                            }
                            await delay(5000);
                        }
                    }
                }

                if (connection === "open") {
                    try {
                        await delay(2000);
                        console.log("[pair] connection OPEN for", jobId, "- building session ID...");
                        const sessionId = encodeSession(authDir);
                        console.log("[pair] session encoded for", jobId, "- length:", sessionId.length);
                        j.status = "linked";
                        j.sessionId = sessionId;
                        saveJobs();
                        await sock.end(undefined);
                        activeSockets.delete(jobId);
                        // Keep job around 5 min so frontend can still fetch it
                        setTimeout(() => cleanupJob(jobId, authDir), 5 * 60 * 1000);
                    } catch (e) {
                        console.error("[pair] FAILED to build session for", jobId, ":", e.message);
                        j.status = "error";
                        j.error = "Linked, but failed to build session ID: " + e.message;
                        saveJobs();
                        activeSockets.delete(jobId);
                    }
                } else if (connection === "close") {
                    if (j.status === "linked") {
                        activeSockets.delete(jobId);
                        return;
                    }

                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const loggedOut = statusCode === DisconnectReason.loggedOut;

                    if (loggedOut) {
                        j.status = "error";
                        j.error = "Device was logged out during pairing. Please try again.";
                        saveJobs();
                        cleanupJob(jobId, authDir);
                        activeSockets.delete(jobId);
                        return;
                    }

                    j.retries += 1;
                    saveJobs();
                    if (j.retries > MAX_RETRIES) {
                        j.status = "error";
                        j.error = "Could not complete pairing after several attempts (status " + statusCode + "). Please try again.";
                        saveJobs();
                        cleanupJob(jobId, authDir);
                        activeSockets.delete(jobId);
                        return;
                    }

                    console.log("[pair] connection closed for", jobId, "- retry", j.retries, "/", MAX_RETRIES);
                    await delay(1000);
                    startSocket().catch((e) => {
                        const jj = jobs.get(jobId);
                        if (jj) {
                            jj.status = "error";
                            jj.error = "Reconnect failed: " + e.message;
                            saveJobs();
                        }
                        activeSockets.delete(jobId);
                    });
                }
            });
        } catch (e) {
            console.error("[pair] socket setup failed for", jobId, ":", e.message);
            const job = jobs.get(jobId);
            if (job) {
                job.status = "error";
                job.error = e.message;
                saveJobs();
            }
            fs.rm(authDir, { recursive: true, force: true }, () => {});
            activeSockets.delete(jobId);
        }
    }

    try {
        await startSocket();
    } catch (e) {
        console.error("[pair] fatal startSocket error:", e.message);
        const job = jobs.get(jobId);
        if (job) {
            job.status = "error";
            job.error = e.message;
            saveJobs();
        }
        fs.rm(authDir, { recursive: true, force: true }, () => {});
        activeSockets.delete(jobId);
    }
});

app.get("/api/status/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found or expired" });
    res.json(job);
});

app.listen(PORT, () => {
    console.log(SITE_NAME + " running on http://127.0.0.1:" + PORT);
});
