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

const { encodeSession, SESSION_STORE, PREFIX } = require("./sessionCodec");

const PORT = process.env.PORT || 4000;
const DEFAULT_SITE_NAME = "MAHNGUELOH VANTA";
const SITE_NAME = process.env.SITE_NAME || DEFAULT_SITE_NAME;
const TEMP_ROOT = path.join(__dirname, "temp_sessions");
const CHANNEL_URL = "https://whatsapp.com/channel/0029Vb7B7pS6rsQksHVznm0j";

if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();

function cleanupJob(jobId, authDir) {
    jobs.delete(jobId);
    fs.rm(authDir, { recursive: true, force: true }, () => {});
}

app.get("/api/site-name", (req, res) => {
    res.json({ name: DEFAULT_SITE_NAME });
});

// ── Redeem a short "MH~..." session ID ──────────────────────────────────────
// encodeSession() only ever PUT the bundle into SESSION_STORE — nothing in
// this file ever read it back out. That meant every "MH~" ID handed to a
// bot was a dead end: it looked like a session ID but could never actually
// be redeemed by anything, because the data only ever lived in this
// process's memory with no way to fetch it. This is that missing piece.
//
// One-time use and short-lived on purpose: the bundle is deleted the moment
// it's successfully fetched, on top of the existing 30-minute TTL in
// sessionCodec.js, so a leaked/old link can't be replayed later.
app.get("/api/session/:id", (req, res) => {
    const id = String(req.params.id || "");
    if (!id.startsWith(PREFIX)) {
        return res.status(400).json({ error: "Not a valid session ID (wrong prefix)" });
    }
    const bundle = SESSION_STORE.get(id);
    if (!bundle) {
        return res.status(404).json({ error: "Session not found or expired — sessions last 30 minutes and can only be redeemed once. Generate a new one." });
    }
    SESSION_STORE.delete(id);
    res.json({ bundle });
});

app.post("/api/pair", async (req, res) => {
    const number = String(req.body.number || "").replace(/[^0-9]/g, "");
    if (!number || number.length < 8) {
        return res.status(400).json({ error: "Enter a valid phone number with country code, digits only." });
    }

    const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const authDir = path.join(TEMP_ROOT, jobId);

    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(authDir, { recursive: true });

    jobs.set(jobId, { status: "starting", code: null, sessionId: null, error: null, retries: 0 });

    res.json({ jobId });

    const MAX_RETRIES = 8;
    let socket = null;

    async function startSocket() {
        const job = jobs.get(jobId);
        if (!job) return;

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const logger = pino({ level: "silent" });

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

        socket = makeWASocket({
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

        socket.ev.on("creds.update", saveCreds);

        let pairingRequested = false;

        socket.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const j = jobs.get(jobId);
            if (!j) return;

            if (qr && needsPairing && !pairingRequested && !j.code) {
                pairingRequested = true;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const code = await socket.requestPairingCode(number);
                        j.status = "code_ready";
                        j.code = code?.replace(/\W/g, "").match(/.{1,4}/g)?.join("-") || code;
                        console.log(`[${jobId}] Pairing code ready: ${j.code}`);
                        break;
                    } catch (e) {
                        if (attempt === 3) {
                            j.status = "error";
                            j.error = "Failed to request pairing code: " + e.message;
                            console.error(`[${jobId}] Code request failed:`, e.message);
                            cleanupJob(jobId, authDir);
                            return;
                        }
                        await delay(5000);
                    }
                }
            }

            if (connection === "open") {
                try {
                    console.log(`[${jobId}] Connection opened, waiting for Baileys to write files...`);
                    await delay(4000);

                    const files = fs.readdirSync(authDir);
                    console.log(`[${jobId}] Auth directory contents:`, files);

                    let totalFiles = 0;
                    function countFiles(dir) {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isDirectory()) {
                                countFiles(path.join(dir, entry.name));
                            } else {
                                totalFiles++;
                            }
                        }
                    }
                    countFiles(authDir);

                    if (totalFiles === 0) {
                        throw new Error("No auth files found after connection");
                    }

                    console.log(`[${jobId}] Found ${totalFiles} files, encoding session...`);
                    const sessionId = encodeSession(authDir);

                    if (!sessionId) {
                        throw new Error("Session ID generation failed");
                    }

                    j.status = "linked";
                    j.sessionId = sessionId;
                    console.log(`[${jobId}] ✅ Session ID generated (length: ${sessionId.length})`);

                    try {
                        await delay(1000);
                        const jid = number + "@s.whatsapp.net";
                        await socket.sendMessage(jid, { text: sessionId });
                        console.log(`[${jobId}] ✅ Session sent to ${number}`);
                    } catch (e) {
                        console.error(`[${jobId}] Failed to send session:`, e.message);
                    }

                    try {
                        await delay(500);
                        const jid = number + "@s.whatsapp.net";
                        const successMsg = `✅ Welcome to MAHNGUELOH VANTA\n\n🎉 Connection successful!\n\n📢 Join our updates channel:\n${CHANNEL_URL}\n\n📞 Support: https://wa.me/254725776602`;
                        await socket.sendMessage(jid, { text: successMsg });
                        console.log(`[${jobId}] ✅ Welcome + channel invite sent`);
                    } catch (e) {
                        console.error(`[${jobId}] Failed to send welcome/channel message:`, e.message);
                    }

                    await delay(2000);

                    try {
                        await socket.end(undefined);
                    } catch (e) {
                        console.log(`[${jobId}] Socket end error (non-fatal):`, e.message);
                    }

                    setTimeout(() => cleanupJob(jobId, authDir), 5 * 60 * 1000);
                } catch (e) {
                    j.status = "error";
                    j.error = "Linked, but failed to build session ID: " + e.message;
                    console.error(`[${jobId}] Session encoding failed:`, e.message, e.stack);
                }
            } else if (connection === "close") {
                if (j.status === "linked") return;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                if (loggedOut) {
                    j.status = "error";
                    j.error = "Device was logged out during pairing. Please try again.";
                    console.log(`[${jobId}] Logged out during pairing`);
                    cleanupJob(jobId, authDir);
                    return;
                }

                j.retries += 1;
                console.log(`[${jobId}] Disconnect (status ${statusCode}), retry ${j.retries}/${MAX_RETRIES}`);

                if (j.retries > MAX_RETRIES) {
                    j.status = "error";
                    j.error = "Could not complete pairing after several attempts. Please try again.";
                    console.error(`[${jobId}] Max retries exceeded`);
                    cleanupJob(jobId, authDir);
                    return;
                }

                await delay(1500);
                startSocket().catch((e) => {
                    const jj = jobs.get(jobId);
                    if (jj) {
                        jj.status = "error";
                        jj.error = "Reconnect failed: " + e.message;
                    }
                    console.error(`[${jobId}] Reconnect error:`, e.message);
                });
            }
        });
    }

    try {
        await startSocket();
    } catch (e) {
        const job = jobs.get(jobId);
        if (job) {
            job.status = "error";
            job.error = e.message;
        }
        console.error(`[${jobId}] Pairing error:`, e.message);
        fs.rm(authDir, { recursive: true, force: true }, () => {});
    }
});

app.get("/api/status/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found or expired" });
    res.json(job);
});

app.listen(PORT, () => {
    console.log(`${SITE_NAME} running on http://127.0.0.1:${PORT}`);
});
