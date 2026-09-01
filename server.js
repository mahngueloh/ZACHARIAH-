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

const { encodeSession } = require("./sessionCodec");

const PORT = process.env.PORT || 4000;
const SITE_NAME = process.env.SITE_NAME || "MAHNGUELOH MD SESSION";
const TEMP_ROOT = path.join(__dirname, "temp_sessions");

if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory job tracker: sessionJobId -> { status, code, sessionId, error }
const jobs = new Map();

function cleanupJob(jobId, authDir) {
    jobs.delete(jobId);
    fs.rm(authDir, { recursive: true, force: true }, () => {});
}

app.get("/api/site-name", (req, res) => {
    res.json({ name: SITE_NAME });
});

// Kick off a pairing attempt for a phone number. Returns a jobId the
// frontend polls via /api/status/:jobId to get the code, then the
// final session ID once WhatsApp confirms the link.
app.post("/api/pair", async (req, res) => {
    const number = String(req.body.number || "").replace(/[^0-9]/g, "");
    if (!number || number.length < 8) {
        return res.status(400).json({ error: "Enter a valid phone number with country code, digits only." });
    }

    const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    // Create a unique auth directory for this specific pairing
    const authDir = path.join(TEMP_ROOT, jobId);
    
    // Make absolutely sure this is a fresh directory
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(authDir, { recursive: true });

    jobs.set(jobId, { status: "starting", code: null, sessionId: null, error: null, retries: 0 });

    res.json({ jobId });

    // How many times we'll silently reconnect if WhatsApp closes the
    // connection while we're still waiting for the code to be entered.
    const MAX_RETRIES = 8;
    let socket = null;

    async function startSocket() {
        const job = jobs.get(jobId);
        if (!job) return; // job was cleaned up — nothing to do

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
            version = [2, 3000, 1015920675]; // known-good fallback
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
                    // Give Baileys extra time on Render
                    await delay(4000);
                    
                    // Verify auth files exist
                    const files = fs.readdirSync(authDir);
                    console.log(`[${jobId}] Auth directory contents:`, files);
                    
                    // Check nested dirs too
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
                    
                    if (!sessionId || sessionId.length < 50) {
                        throw new Error("Session ID too short or empty");
                    }
                    
                    j.status = "linked";
                    j.sessionId = sessionId;
                    console.log(`[${jobId}] ✅ Session ID generated (length: ${sessionId.length})`);
                    
                    // Send ONLY the pure session ID (no extra text)
                    try {
                        await delay(1000);
                        const jid = number + "@s.whatsapp.net";
                        await socket.sendMessage(jid, { text: sessionId });
                        console.log(`[${jobId}] ✅ Session sent to ${number}`);
                    } catch (e) {
                        console.error(`[${jobId}] Failed to send session:`, e.message);
                        console.error(`[${jobId}] Fallback session ID: ${sessionId}`);
                    }
                    
                    // Send welcome/success message after session
                    try {
                        await delay(500);
                        const jid = number + "@s.whatsapp.net";
                        const successMsg = `✅ Welcome to MAHNGUELOH MD\n\n🎉 Connection successful!\n\n📞 Support: https://wa.me/254725776602`;
                        await socket.sendMessage(jid, { text: successMsg });
                        console.log(`[${jobId}] ✅ Welcome message sent`);
                    } catch (e) {
                        console.error(`[${jobId}] Failed to send welcome message:`, e.message);
                    }
                    
                    // Wait for messages to flush before closing
                    await delay(2000);
                    
                    try {
                        await socket.end(undefined);
                    } catch (e) {
                        console.log(`[${jobId}] Socket end error (non-fatal):`, e.message);
                    }
                    
                    // Keep the job around for a few minutes so the frontend
                    // can still fetch the result, then clean up.
                    setTimeout(() => cleanupJob(jobId, authDir), 5 * 60 * 1000);
                } catch (e) {
                    j.status = "error";
                    j.error = "Linked, but failed to build session ID: " + e.message;
                    console.error(`[${jobId}] Session encoding failed:`, e.message, e.stack);
                }
            } else if (connection === "close") {
                if (j.status === "linked") return; // already done, nothing to retry

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

                // Reconnect quietly and keep showing the same code
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
