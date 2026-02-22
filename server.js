import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 25;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 2;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 180_000;

// Path to the Python worker (same dir as server.js)
const WORKER_PATH = new URL("ocr_worker.py", import.meta.url).pathname;

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

const SUPPORTED_LANGS = new Set([
    "fra", "eng", "deu", "spa", "ita", "por", "nld",
    "ara", "chi_sim", "chi_tra", "jpn", "kor", "rus",
]);

// ─── Semaphore (concurrency limiter) ─────────────────────────────────────────

class Semaphore {
    #queue = [];
    #running = 0;
    #max;

    constructor(max) { this.#max = max; }

    acquire() {
        return new Promise((resolve) => {
            const tryRun = () => {
                if (this.#running < this.#max) {
                    this.#running++;
                    resolve(() => {
                        this.#running--;
                        if (this.#queue.length) this.#queue.shift()();
                    });
                } else {
                    this.#queue.push(tryRun);
                }
            };
            tryRun();
        });
    }
}

const sem = new Semaphore(MAX_CONCURRENT_JOBS);

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, msg, extra = {}) {
    console[level === "error" ? "error" : "log"](
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })
    );
}

// ─── Python process runner ────────────────────────────────────────────────────

function runPython(args, { timeoutMs = OCR_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        log("info", "spawn python", { args });

        const p = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
            p.kill("SIGKILL");
            reject(new Error(`Python worker timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        p.stdout.on("data", (d) => (stdout += d.toString()));
        p.stderr.on("data", (d) => (stderr += d.toString()));

        p.on("close", (code) => {
            clearTimeout(timer);

            // Worker always writes JSON to stdout, even on error
            let parsed;
            try {
                parsed = JSON.parse(stdout.trim());
            } catch {
                return reject(new Error(
                    `Worker returned non-JSON output (exit ${code}): ${(stdout || stderr).slice(0, 500)}`
                ));
            }

            if (parsed.error) {
                return reject(new Error(parsed.error));
            }

            resolve(parsed);
        });

        p.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`python3 spawn error: ${e.message}`));
        });
    });
}

// ─── Validators ───────────────────────────────────────────────────────────────

function isPdfBuffer(buf) {
    return buf.length >= 4 && buf.slice(0, 4).equals(PDF_MAGIC);
}

function sanitizeLang(raw) {
    const lang = raw.toString().toLowerCase().trim();
    if (!SUPPORTED_LANGS.has(lang)) {
        throw Object.assign(
            new Error(`Unsupported lang: '${lang}'. Supported: ${[...SUPPORTED_LANGS].join(", ")}`),
            { status: 400 }
        );
    }
    return lang;
}

// ─── OCR pipeline ─────────────────────────────────────────────────────────────

async function runOcr({ buffer, lang }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
    const inPdf = path.join(tmpDir, "input.pdf");

    try {
        await fs.writeFile(inPdf, buffer);

        const result = await runPython([WORKER_PATH, inPdf, lang]);

        return {
            text: result.text ?? "",
            page_count: result.page_count ?? null,
        };
    } finally {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

app.disable("x-powered-by");

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.json({ ok: true, concurrent: MAX_CONCURRENT_JOBS, engine: "doctr" });
});

// ── OCR endpoint ──────────────────────────────────────────────────────────────
app.post("/ocr", upload.single("file"), async (req, res) => {
    const reqId = Math.random().toString(36).slice(2, 8);
    log("info", "ocr request", { reqId, size: req.file?.size });

    // Validate file presence
    if (!req.file) {
        return res.status(400).json({ error: "Missing field 'file'" });
    }

    // Validate PDF magic bytes
    if (!isPdfBuffer(req.file.buffer)) {
        return res.status(415).json({ error: "File does not appear to be a valid PDF" });
    }

    // Validate language (passed to worker for logging; Doctr uses its own models)
    let lang;
    try {
        lang = sanitizeLang(req.query.lang || "fra");
    } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
    }

    // Acquire concurrency slot
    const release = await sem.acquire();

    try {
        const result = await runOcr({ buffer: req.file.buffer, lang });
        log("info", "ocr done", { reqId, pages: result.page_count, chars: result.text.length });
        res.json(result);
    } catch (e) {
        log("error", "ocr failed", { reqId, error: e.message });
        res.status(500).json({ error: e.message });
    } finally {
        release();
    }
});

// ── Multer error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit` });
    }
    log("error", "unhandled middleware error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => log("info", `OCR service listening on :${PORT}`, { engine: "doctr" }));