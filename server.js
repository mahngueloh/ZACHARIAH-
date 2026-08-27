const path = require("path");
const fs = require("fs");
const express = require("express");
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay,
} = require("@whiskeysockets/baileys");

const { encodeSession } = require("./lib/sessionCodec");

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
    const authDir = path.join(TEMP_ROOT, jobId);
    fs.mkdirSync(authDir, { recursive: true });

    jobs.set(jobId, { status: "starting", code: null, sessionId: null, error: null, retries: 0 });

    res.json({ jobId });

    // How many times we'll silently reconnect if WhatsApp closes the
    // connection while we're still waiting for the code to be entered.
    // This is normal/expected during pairing, not a real failure —
    // we only give up after several bad closes in a row.
    const MAX_RETRIES = 6;

    async function startSocket() {
        const job = jobs.get(jobId);
        if (!job) return; // job was cleaned up (e.g. server restarted) — nothing to do

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const logger = pino({ level: "silent" });

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: ["MAHNGUELOH MD SESSION", "Chrome", "1.0"],
        });

        sock.ev.on("creds.update", saveCreds);

        // Only request a fresh pairing code the first time — on a retry
        // after a routine reconnect, the previously issued code is still
        // valid, so we keep showing it rather than confusing the user
        // with a new one every few seconds.
        if (!sock.authState.creds.registered && !job.code) {
            await delay(1500);
            try {
                const code = await sock.requestPairingCode(number);
                const j = jobs.get(jobId);
                if (j) {
                    j.status = "code_ready";
                    j.code = code?.match(/.{1,4}/g)?.join("-") || code;
                }
            } catch (e) {
                const j = jobs.get(jobId);
                if (j) {
                    j.status = "error";
                    j.error = "Failed to request pairing code: " + e.message;
                }
                return;
            }
        }

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            const j = jobs.get(jobId);
            if (!j) return;

            if (connection === "open") {
                try {
                    // Give Baileys a moment to finish writing all key files.
                    await delay(2000);
                    const sessionId = encodeSession(authDir);
                    j.status = "linked";
                    j.sessionId = sessionId;
                    await sock.end(undefined);
                    // Keep the job around for a few minutes so the frontend
                    // can still fetch the result, then clean up.
                    setTimeout(() => cleanupJob(jobId, authDir), 5 * 60 * 1000);
                } catch (e) {
                    j.status = "error";
                    j.error = "Linked, but failed to build session ID: " + e.message;
                }
            } else if (connection === "close") {
                if (j.status === "linked") return; // already done, nothing to retry

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                if (loggedOut) {
                    j.status = "error";
                    j.error = "Device was logged out during pairing. Please try again.";
                    cleanupJob(jobId, authDir);
                    return;
                }

                j.retries += 1;
                if (j.retries > MAX_RETRIES) {
                    j.status = "error";
                    j.error = "Could not complete pairing after several attempts (status " + statusCode + "). Please try again.";
                    cleanupJob(jobId, authDir);
                    return;
                }

                // Routine close while waiting for the code to be entered —
                // reconnect quietly and keep showing the same code.
                await delay(1000);
                startSocket().catch((e) => {
                    const jj = jobs.get(jobId);
                    if (jj) {
                        jj.status = "error";
                        jj.error = "Reconnect failed: " + e.message;
                    }
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
