import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import readline from "readline";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 25;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 60_000;
const WORKER_READY_TIMEOUT = Number(process.env.WORKER_READY_TIMEOUT) || 120_000;
const QUEUE_MAX_SIZE = Number(process.env.QUEUE_MAX_SIZE) || 50;

// Nombre de workers Python en parallèle.
// Règle : 1 worker ≈ 1-1.5 GB RAM (torch + modèle).
// Défaut : nb de CPU logiques, plafonné à 4.
const WORKER_COUNT = Number(process.env.WORKER_COUNT) || Math.min(os.cpus().length, 4);

const WORKER_PATH = new URL("ocr_worker.py", import.meta.url).pathname;
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);

const SUPPORTED_LANGS = new Set([
    "fra", "eng", "deu", "spa", "ita", "por", "nld",
    "ara", "chi_sim", "chi_tra", "jpn", "kor", "rus",
]);

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, msg, extra = {}) {
    console[level === "error" ? "error" : "log"](
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })
    );
}

// ─── Single Python Worker ─────────────────────────────────────────────────────

class PythonWorker {
    #id;
    #proc = null;
    #rl = null;
    #pending = new Map();     // reqId → { resolve, reject, timer }
    #ready = false;
    #busy = false;
    #_resolveReady;
    #_rejectReady;
    #readyPromise;
    #pool;                    // référence au pool parent pour signaler crash

    constructor(id, pool) {
        this.#id = id;
        this.#pool = pool;
    }

    get id() { return this.#id; }
    get ready() { return this.#ready; }
    get busy() { return this.#busy; }

    start() {
        this.#ready = false;
        this.#readyPromise = new Promise((res, rej) => {
            this.#_resolveReady = res;
            this.#_rejectReady = rej;
        });

        this.#proc = spawn("python3", ["-u", WORKER_PATH], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, PYTHONUNBUFFERED: "1", TF_CPP_MIN_LOG_LEVEL: "3", DOCTR_MULTIPROCESSING_DISABLE: "TRUE" },
        });

        this.#proc.stderr.on("data", (d) =>
            log("info", `worker-${this.#id} stderr`, { msg: d.toString().trim().slice(0, 500) })
        );

        this.#rl = readline.createInterface({ input: this.#proc.stdout });
        this.#rl.on("line", (line) => this.#onLine(line));

        const readyTimer = setTimeout(() => {
            if (!this.#ready) {
                this.#_rejectReady(new Error(`Worker ${this.#id} ready timeout`));
                this.#proc.kill("SIGKILL");
            }
        }, WORKER_READY_TIMEOUT);

        this.#proc.once("close", (code) => {
            clearTimeout(readyTimer);
            this.#ready = false;
            this.#busy = false;
            log("error", `worker-${this.#id} exited`, { code });

            for (const [, { reject: rej, timer }] of this.#pending) {
                clearTimeout(timer);
                rej(new Error(`Worker ${this.#id} crashed (exit ${code})`));
            }
            this.#pending.clear();

            if (!this.#ready) this.#_rejectReady?.(new Error(`Worker exited before ready`));

            // Signaler le crash au pool → redémarrage
            this.#pool.onWorkerCrash(this.#id);
        });

        this.#proc.on("error", (e) => {
            clearTimeout(readyTimer);
            this.#_rejectReady(new Error(`spawn error: ${e.message}`));
        });

        return this.#readyPromise;
    }

    #onLine(line) {
        line = line.trim();
        if (!line) return;
        let msg;
        try { msg = JSON.parse(line); } catch {
            log("warn", `worker-${this.#id} non-JSON`, { line: line.slice(0, 200) });
            return;
        }

        if (msg.ready === true) {
            this.#ready = true;
            this.#_resolveReady();
            log("info", `worker-${this.#id} ready`);
            return;
        }
        if (msg.ready === false) {
            this.#_rejectReady(new Error(msg.error || "Worker failed to load model"));
            return;
        }

        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(msg.id);
        this.#busy = false;
        this.#pool.onWorkerFree(this.#id);

        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve({ text: msg.text ?? "", page_count: msg.page_count ?? null });
    }

    async ocr(pdfPath) {
        await this.#readyPromise;
        const id = randomBytes(8).toString("hex");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                this.#busy = false;
                this.#pool.onWorkerFree(this.#id);
                reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`));
            }, OCR_TIMEOUT_MS);
            this.#busy = true;
            this.#pending.set(id, { resolve, reject, timer });
            this.#proc.stdin.write(JSON.stringify({ id, pdf_path: pdfPath }) + "\n");
        });
    }

    kill() {
        try { this.#proc?.kill("SIGTERM"); } catch { /* ignore */ }
    }
}

// ─── Worker Pool + Queue ──────────────────────────────────────────────────────

class WorkerPool {
    #workers = [];
    #queue = [];          // { pdfPath, resolve, reject, timer, reqId }
    #restarting = new Set();

    async init(count) {
        log("info", `Initializing pool with ${count} workers...`);
        const starts = Array.from({ length: count }, (_, i) => {
            const w = new PythonWorker(i, this);
            this.#workers.push(w);
            return w.start();
        });
        // On attend que AU MOINS 1 worker soit prêt avant d'ouvrir le serveur
        await Promise.any(starts).catch(() => {
            throw new Error("No worker could start");
        });
        // Les autres continuent en arrière-plan
        Promise.allSettled(starts).then(() =>
            log("info", `All ${count} workers started`)
        );
    }

    // Appelé par un worker quand il se libère
    onWorkerFree(workerId) {
        if (this.#queue.length > 0) {
            const job = this.#queue.shift();
            clearTimeout(job.queueTimer);
            const worker = this.#workers.find(w => w.id === workerId && w.ready);
            if (worker) {
                log("info", "dequeue job", { reqId: job.reqId, worker: workerId, queueRemaining: this.#queue.length });
                this.#dispatch(worker, job);
            } else {
                // Le worker n'est plus dispo, remettre en tête de queue
                this.#queue.unshift(job);
            }
        }
    }

    onWorkerCrash(workerId) {
        if (this.#restarting.has(workerId)) return;
        this.#restarting.add(workerId);
        setTimeout(async () => {
            log("info", `Restarting worker-${workerId}...`);
            const worker = this.#workers.find(w => w.id === workerId);
            if (worker) {
                try {
                    await worker.start();
                    log("info", `Worker-${workerId} restarted`);
                } catch (e) {
                    log("error", `Worker-${workerId} restart failed`, { error: e.message });
                }
            }
            this.#restarting.delete(workerId);
            // Drainer la queue si des jobs attendaient
            this.#drainQueue();
        }, 2000);
    }

    #drainQueue() {
        for (const worker of this.#workers) {
            if (!worker.busy && worker.ready && this.#queue.length > 0) {
                const job = this.#queue.shift();
                clearTimeout(job.queueTimer);
                this.#dispatch(worker, job);
            }
        }
    }

    #dispatch(worker, job) {
        worker.ocr(job.pdfPath)
            .then(job.resolve)
            .catch(job.reject);
    }

    async run(pdfPath, reqId) {
        // Chercher un worker libre
        const freeWorker = this.#workers.find(w => w.ready && !w.busy);
        if (freeWorker) {
            return freeWorker.ocr(pdfPath);
        }

        // Tous occupés → mise en queue
        if (this.#queue.length >= QUEUE_MAX_SIZE) {
            throw Object.assign(new Error("Queue full, server overloaded"), { status: 503 });
        }

        log("info", "queuing job", { reqId, queueSize: this.#queue.length + 1 });

        return new Promise((resolve, reject) => {
            const queueTimer = setTimeout(() => {
                const idx = this.#queue.findIndex(j => j.reqId === reqId);
                if (idx !== -1) this.#queue.splice(idx, 1);
                reject(new Error(`Job queued too long (>${OCR_TIMEOUT_MS}ms)`));
            }, OCR_TIMEOUT_MS);

            this.#queue.push({ pdfPath, resolve, reject, queueTimer, reqId });
        });
    }

    get stats() {
        return {
            workers: this.#workers.map(w => ({ id: w.id, ready: w.ready, busy: w.busy })),
            queue_size: this.#queue.length,
        };
    }
}

const pool = new WorkerPool();

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

async function runOcr({ buffer, reqId }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
    const inPdf = path.join(tmpDir, "input.pdf");
    try {
        await fs.writeFile(inPdf, buffer);
        return await pool.run(inPdf, reqId);
    } finally {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
    const stats = pool.stats;
    const allDown = stats.workers.every(w => !w.ready);
    res.status(allDown ? 503 : 200).json({
        ok: !allDown,
        engine: "doctr",
        ...stats,
    });
});

app.post("/ocr", upload.single("file"), async (req, res) => {
    const reqId = randomBytes(4).toString("hex");
    log("info", "ocr request", { reqId, size: req.file?.size });

    if (!req.file)
        return res.status(400).json({ error: "Missing field 'file'" });
    if (!isPdfBuffer(req.file.buffer))
        return res.status(415).json({ error: "File does not appear to be a valid PDF" });

    let lang;
    try { lang = sanitizeLang(req.query.lang || "fra"); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const t0 = Date.now();
    try {
        const result = await runOcr({ buffer: req.file.buffer, reqId });
        log("info", "ocr done", { reqId, pages: result.page_count, chars: result.text.length, ms: Date.now() - t0 });
        res.json(result);
    } catch (e) {
        const status = e.status || 500;
        log("error", "ocr failed", { reqId, error: e.message, ms: Date.now() - t0 });
        res.status(status).json({ error: e.message });
    }
});

app.use((err, _req, res, _next) => {
    if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit` });
    log("error", "unhandled middleware error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

pool.init(WORKER_COUNT)
    .then(() => {
        app.listen(PORT, () =>
            log("info", `OCR service listening on :${PORT}`, { workers: WORKER_COUNT, engine: "doctr-pool" })
        );
    })
    .catch((e) => {
        log("error", "Fatal: pool init failed", { error: e.message });
        process.exit(1);
    });