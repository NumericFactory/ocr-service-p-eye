import express from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 25;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 2;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 180_000;
const PDFINFO_TIMEOUT_MS = 20_000;
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

const SUPPORTED_LANGS = new Set([
    "fra", "eng", "deu", "spa", "ita", "por", "nld",
    "ara", "chi_sim", "chi_tra", "jpn", "kor", "rus",
]);

// Script Python PassportEye — injecté au runtime dans un fichier temp
const PASSPORT_EYE_SCRIPT = `
import sys
import json

def read_mrz(image_path):
    try:
        from passporteye import read_mrz
        mrz = read_mrz(image_path)
        if mrz is None:
            return {"ok": False, "error": "no_mrz_detected"}

        data = mrz.to_dict()

        # Vérification des checksums ICAO intégrée dans PassportEye
        valid_score = mrz.valid_score  # 0-100, 100 = toutes checksums OK

        return {
            "ok": True,
            "valid_score": valid_score,
            "all_checksums_ok": mrz.valid,
            "type": data.get("type", ""),
            "country": data.get("country", ""),
            "number": data.get("number", ""),           # numéro de carte
            "date_of_birth": data.get("date_of_birth", ""),
            "expiration_date": data.get("expiration_date", ""),
            "nationality": data.get("nationality", ""),
            "sex": data.get("sex", ""),
            "names": data.get("names", ""),
            "surname": data.get("surname", ""),
            "personal_number": data.get("personal_number", ""),
            "mrz_line1": data.get("raw_text", ["", ""])[0] if isinstance(data.get("raw_text"), list) else "",
            "mrz_line2": data.get("raw_text", ["", ""])[1] if isinstance(data.get("raw_text"), list) else "",
        }
    except ImportError:
        return {"ok": False, "error": "passporteye_not_installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    result = read_mrz(sys.argv[1])
    print(json.dumps(result))
`;

// ─── Semaphore ────────────────────────────────────────────────────────────────

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

// ─── Process runner ───────────────────────────────────────────────────────────

function run(cmd, args, { timeoutMs = OCR_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";

        const timer = setTimeout(() => {
            p.kill("SIGKILL");
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        p.stdout.on("data", (d) => (out += d.toString()));
        p.stderr.on("data", (d) => (err += d.toString()));

        p.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ out, err });
            else reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(0, 500)}`));
        });

        p.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`${cmd} spawn error: ${e.message}`));
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

// ─── PassportEye MRZ reader ───────────────────────────────────────────────────

// Initialise le script Python au démarrage (une seule fois)
let pythonScriptPath = null;

async function initPythonScript() {
    const tmpScript = path.join(os.tmpdir(), "mrz_reader.py");
    await fs.writeFile(tmpScript, PASSPORT_EYE_SCRIPT, "utf-8");
    pythonScriptPath = tmpScript;
    log("info", "PassportEye script initialized", { path: tmpScript });
}

/**
 * Convertit la première page d'un PDF en image PNG haute résolution
 * puis la passe à PassportEye.
 * Retourne le résultat JSON de PassportEye ou null si échec.
 */
async function readMrzWithPassportEye(pdfPath, tmpDir) {
    // 1. PDF → PNG 300dpi (pdftoppm est déjà dans l'image)
    const imgBase = path.join(tmpDir, "page");
    await run("pdftoppm", [
        "-r", "300",      // 300 DPI pour une bonne lisibilité OCR-B
        "-png",
        "-f", "1",        // première page uniquement
        "-l", "1",
        pdfPath,
        imgBase,
    ], { timeoutMs: 30_000 });

    // pdftoppm génère page-1.png (ou page-01.png selon la version)
    const candidates = ["page-1.png", "page-01.png", "page-001.png"];
    let imgPath = null;
    for (const c of candidates) {
        try {
            await fs.access(path.join(tmpDir, c));
            imgPath = path.join(tmpDir, c);
            break;
        } catch { /* continue */ }
    }

    if (!imgPath) {
        // Cherche n'importe quel PNG généré
        const files = await fs.readdir(tmpDir);
        const png = files.find((f) => f.startsWith("page") && f.endsWith(".png"));
        if (!png) throw new Error("pdftoppm n'a produit aucun fichier PNG");
        imgPath = path.join(tmpDir, png);
    }

    // 2. PassportEye via Python
    const { out } = await run("python3", [pythonScriptPath, imgPath], { timeoutMs: 60_000 });

    try {
        return JSON.parse(out.trim());
    } catch {
        throw new Error(`PassportEye output non-JSON: ${out.slice(0, 200)}`);
    }
}

// ─── OCR pipeline (Tesseract — inchangé) ─────────────────────────────────────

async function runOcr({ buffer, lang, returnPdf }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
    const inPdf = path.join(tmpDir, "input.pdf");
    const outPdf = path.join(tmpDir, "output_ocr.pdf");
    const outTxt = path.join(tmpDir, "output.txt");

    try {
        await fs.writeFile(inPdf, buffer);

        await run("ocrmypdf", [
            "--force-ocr", "--rotate-pages", "--deskew",
            "--oversample", "300", "--optimize", "0",
            "--language", lang,
            "--sidecar", outTxt,
            inPdf, outPdf,
        ]);

        let text = "";
        try {
            await run("pdftotext", ["-layout", outPdf, outTxt], { timeoutMs: 30_000 });
            text = await fs.readFile(outTxt, "utf-8");
        } catch (e) {
            log("warn", "pdftotext failed, using sidecar fallback", { error: e.message });
            text = await fs.readFile(outTxt, "utf-8").catch(() => "");
        }

        let page_count = null;
        try {
            const { out } = await run("pdfinfo", [outPdf], { timeoutMs: PDFINFO_TIMEOUT_MS });
            const line = out.split("\n").find((l) => l.toLowerCase().startsWith("pages:"));
            if (line) page_count = parseInt(line.split(":")[1].trim(), 10);
        } catch (e) {
            log("warn", "pdfinfo failed", { error: e.message });
        }

        const result = { text: text.trim(), page_count };
        if (returnPdf) {
            const pdfBuf = await fs.readFile(outPdf);
            result.pdf_base64 = pdfBuf.toString("base64");
        }
        return result;
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
    res.json({ ok: true, concurrent: MAX_CONCURRENT_JOBS });
});

// ── OCR brut (Tesseract) ──────────────────────────────────────────────────────
app.post("/ocr", upload.single("file"), async (req, res) => {
    const reqId = Math.random().toString(36).slice(2, 8);
    log("info", "ocr request", { reqId, size: req.file?.size });

    if (!req.file) return res.status(400).json({ error: "Missing field 'file'" });
    if (!isPdfBuffer(req.file.buffer)) return res.status(415).json({ error: "File does not appear to be a valid PDF" });

    let lang;
    try { lang = sanitizeLang(req.query.lang || "fra"); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const returnPdf = req.query.return_pdf === "true";
    const release = await sem.acquire();

    try {
        const result = await runOcr({ buffer: req.file.buffer, lang, returnPdf });
        log("info", "ocr done", { reqId, pages: result.page_count, chars: result.text.length });
        res.json(result);
    } catch (e) {
        log("error", "ocr failed", { reqId, error: e.message });
        res.status(500).json({ error: e.message });
    } finally {
        release();
    }
});

// ── Vérification CNI — PassportEye (primaire) + Tesseract (fallback) ──────────
//
// POST /verify-id
// Body : multipart/form-data, champ "file" (PDF)
//
// Réponse 200 :
// {
//   valid: true,
//   method: "passporteye" | "tesseract_fallback",
//   card_number: "190238151174",
//   mrz_line1: "IDFRAGOUABECHE<<...",
//   mrz_line2: "190238151174...",
//   surname: "GOUABECHE",
//   names: "KEVIN",
//   date_of_birth: "930430",
//   expiration_date: "330627",
//   all_checksums_ok: true,   // uniquement si method = passporteye
//   valid_score: 100,         // uniquement si method = passporteye
// }
//
// Réponse 422 : { valid: false, reason, message }
//
app.post("/verify-id", upload.single("file"), async (req, res) => {
    const reqId = Math.random().toString(36).slice(2, 8);
    log("info", "verify-id request", { reqId, size: req.file?.size });

    if (!req.file) return res.status(400).json({ error: "Missing field 'file'" });
    if (!isPdfBuffer(req.file.buffer)) return res.status(415).json({ error: "File does not appear to be a valid PDF" });

    const debug = req.query.debug === "true";
    const release = await sem.acquire();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verifid-"));

    try {
        const inPdf = path.join(tmpDir, "input.pdf");
        await fs.writeFile(inPdf, req.file.buffer);

        // ── Tentative 1 : PassportEye ────────────────────────────────────────────
        let peyeResult = null;
        try {
            peyeResult = await readMrzWithPassportEye(inPdf, tmpDir);
            log("info", "passporteye result", { reqId, ok: peyeResult?.ok, score: peyeResult?.valid_score });
        } catch (e) {
            log("warn", "passporteye error", { reqId, error: e.message });
        }

        if (peyeResult?.ok && peyeResult.number) {
            // PassportEye a réussi
            return res.json({
                valid: true,
                method: "passporteye",
                card_number: peyeResult.number,
                mrz_line1: peyeResult.mrz_line1,
                mrz_line2: peyeResult.mrz_line2,
                surname: peyeResult.surname,
                names: peyeResult.names,
                date_of_birth: peyeResult.date_of_birth,
                expiration_date: peyeResult.expiration_date,
                nationality: peyeResult.nationality,
                sex: peyeResult.sex,
                all_checksums_ok: peyeResult.all_checksums_ok,
                valid_score: peyeResult.valid_score,
            });
        }

        // ── Tentative 2 : fallback Tesseract ─────────────────────────────────────
        log("info", "fallback to tesseract", { reqId, reason: peyeResult?.error || "peye_no_number" });

        let text = "";
        try {
            const outPdf = path.join(tmpDir, "output_ocr.pdf");
            const outTxt = path.join(tmpDir, "output.txt");

            await run("ocrmypdf", [
                "--force-ocr", "--rotate-pages", "--deskew",
                "--oversample", "300", "--optimize", "0",
                "--language", "fra",
                "--sidecar", outTxt,
                inPdf, outPdf,
            ]);

            try {
                await run("pdftotext", ["-layout", outPdf, outTxt], { timeoutMs: 30_000 });
                text = await fs.readFile(outTxt, "utf-8");
            } catch {
                text = await fs.readFile(outTxt, "utf-8").catch(() => "");
            }
        } catch (e) {
            log("error", "tesseract fallback failed", { reqId, error: e.message });
            return res.status(500).json({
                valid: false,
                reason: "ocr_failed",
                message: "PassportEye et Tesseract ont tous les deux échoué.",
                ...(debug && { passporteye_error: peyeResult?.error, tesseract_error: e.message }),
            });
        }

        // Parse Tesseract
        const cardNumber = extractCardNumberFromText(text);
        const mrzLine2 = extractMrzLine2FromText(text);

        if (!cardNumber) {
            return res.status(422).json({
                valid: false,
                reason: "card_number_not_found",
                message: "Impossible d'extraire le numéro de carte (PassportEye + Tesseract).",
                method: "tesseract_fallback",
                ...(debug && { raw_text: text }),
            });
        }

        if (!mrzLine2) {
            return res.status(422).json({
                valid: false,
                reason: "mrz_line2_not_found",
                message: "Impossible d'extraire la 2ème ligne MRZ.",
                method: "tesseract_fallback",
                card_number: cardNumber,
                ...(debug && { raw_text: text }),
            });
        }

        const mrzMatch = normalizeMrz(mrzLine2).includes(normalizeMrz(cardNumber));
        if (!mrzMatch) {
            return res.status(422).json({
                valid: false,
                reason: "card_number_mrz_mismatch",
                message: `Numéro (${cardNumber}) absent de la MRZ (${mrzLine2}).`,
                method: "tesseract_fallback",
                card_number: cardNumber,
                mrz_line2: mrzLine2,
                ...(debug && { raw_text: text }),
            });
        }

        return res.json({
            valid: true,
            method: "tesseract_fallback",
            card_number: cardNumber,
            mrz_line2: mrzLine2,
            all_checksums_ok: null, // non disponible sans PassportEye
            valid_score: null,
        });

    } catch (e) {
        log("error", "verify-id fatal", { reqId, error: e.message });
        res.status(500).json({ error: e.message });
    } finally {
        release();
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
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

// ─── Helpers Tesseract fallback ───────────────────────────────────────────────

function normalizeMrz(str) {
    return str.toUpperCase().replace(/\s/g, "")
        .replace(/O/g, "0").replace(/I/g, "1").replace(/B/g, "8");
}

function extractCardNumberFromText(text) {
    const labelMatch = text.match(/n[o°º s][s°]?\s*:?\s*([0-9]{12})/i);
    if (labelMatch) return labelMatch[1];
    const lines = text.split("\n");
    for (const line of lines) {
        if (line.includes("<")) continue;
        const m = line.match(/\b([0-9]{12})\b/);
        if (m) return m[1];
    }
    const fallback = text.match(/\b([0-9]{12})\b/);
    return fallback ? fallback[1] : null;
}

function extractMrzLine2FromText(text) {
    const lines = text.split("\n");
    for (const line of lines) {
        const clean = line.replace(/\s/g, "").toUpperCase();
        if (/^[0-9]{9,12}/.test(clean) && clean.includes("<") && clean.length >= 27 && /^[0-9A-Z<]+$/.test(clean)) {
            return clean;
        }
    }
    const fullClean = text.replace(/\s/g, "").toUpperCase();
    const mrzMatches = [...fullClean.matchAll(/([0-9]{9,12}[0-9A-Z]{5,}[<][0-9A-Z<]{10,})/g)];
    if (mrzMatches.length > 0) return mrzMatches.sort((a, b) => b[0].length - a[0].length)[0][0];
    return null;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

await initPythonScript();
app.listen(PORT, () => log("info", `OCR service listening on :${PORT}`));