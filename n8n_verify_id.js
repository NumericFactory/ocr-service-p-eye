// ─── Noeud Code n8n ───────────────────────────────────────────────────────────
// Contexte : microservice OCR Doctr — endpoint POST /ocr
// Input    : items[0].binary.data = PDF de la CNI
//            (ou items[0].json.pdf_url si passage par URL)
// Output   : données structurées CNI + statut de validation MRZ
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers MRZ ───────────────────────────────────────────────────────────────

/**
 * Calcule le checksum MRZ (modulo 10, pondération 7-3-1).
 * Retourne le chiffre de contrôle calculé.
 */
function mrzChecksum(str) {
    const weights = [7, 3, 1];
    const table = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let total = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        let val;
        if (c === "<") val = 0;
        else if (/\d/.test(c)) val = parseInt(c, 10);
        else val = table.indexOf(c);
        if (val < 0) val = 0;
        total += val * weights[i % 3];
    }
    return total % 10;
}

/**
 * Vérifie un checksum MRZ.
 * @param {string} data   - champ à vérifier
 * @param {string} check  - caractère de contrôle (doit être un chiffre)
 */
function checksumOk(data, check) {
    return mrzChecksum(data) === parseInt(check, 10);
}

/**
 * Convertit une date MRZ YYMMDD en ISO YYYY-MM-DD.
 * Heuristique siècle : > 30 → 19xx, sinon 20xx.
 */
function parseMrzDate(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return null;
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = yymmdd.slice(2, 4);
    const dd = yymmdd.slice(4, 6);
    const yyyy = yy > 30 ? `19${String(yy).padStart(2, "0")}` : `20${String(yy).padStart(2, "0")}`;
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Nettoie le texte OCR pour la recherche de MRZ :
 * - homoglyphes courants (O→0, I→1, etc.)
 * - espaces parasites dans les lignes MRZ
 */
function normalizeLine(line) {
    return line
        .toUpperCase()
        .replace(/\s+/g, "")           // retire tous les espaces
        .replace(/O/g, "0")            // O → 0 dans les zones numériques (géré au parsing)
        .replace(/\u00AB|\u00BB/g, "<") // guillemets → <
        .replace(/[^\w<]/g, "");        // retire tout sauf alphanum et <
}

// ── Parser MRZ TD1 (carte d'identité française, 3 lignes × 30 car) ────────────

/**
 * Tente d'extraire une MRZ TD1 depuis le texte brut.
 * Retourne null si aucune MRZ valide trouvée.
 */
function parseMrzTD1(rawText) {
    // On cherche des lignes qui ressemblent à des lignes MRZ (≥ 25 car alphanum + <)
    const candidates = rawText
        .split(/\n/)
        .map(l => normalizeLine(l))
        .filter(l => l.length >= 25 && /^[A-Z0-9<]+$/.test(l));

    // Cherche un triplet de lignes consécutives de ~30 caractères
    for (let i = 0; i <= candidates.length - 3; i++) {
        const l1 = candidates[i].slice(0, 30).padEnd(30, "<");
        const l2 = candidates[i + 1].slice(0, 30).padEnd(30, "<");
        const l3 = candidates[i + 2].slice(0, 30).padEnd(30, "<");

        // Ligne 1 : doit commencer par "ID" + code pays (ex: IDFRA)
        if (!l1.startsWith("ID")) continue;

        // Ligne 2 : checksums date naissance (pos 0-5 + check pos 6)
        //           et date expiration (pos 8-13 + check pos 14)
        const dobRaw = l2.slice(0, 6);
        const dobCheck = l2[6];
        const expRaw = l2.slice(8, 14);
        const expCheck = l2[14];

        const dobOk = checksumOk(dobRaw, dobCheck);
        const expOk = checksumOk(expRaw, expCheck);

        // Ligne 3 : noms (séparés par <<)
        const namePart = l3.replace(/^([A-Z<]+)<<([A-Z<]*).*/, "$1|$2");
        const [rawSurname, rawNames] = namePart.includes("|")
            ? namePart.split("|")
            : [namePart, ""];

        const surname = rawSurname.replace(/</g, " ").trim();
        const names = rawNames.replace(/</g, " ").trim();

        // Numéro de carte : ligne 1 positions 5-14
        const cardNumber = l1.slice(5, 14).replace(/</g, "");

        // Checksum composite (facultatif — disponible sur CNI récentes)
        const compositeData = l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29);
        const compositeCheck = l2[29];
        const compositeOk = checksumOk(compositeData, compositeCheck);

        return {
            mrz_line1: l1,
            mrz_line2: l2,
            mrz_line3: l3,
            card_number: cardNumber,
            nationality: l1.slice(2, 5).replace(/</g, ""),
            date_of_birth: parseMrzDate(dobRaw),
            expiration_date: parseMrzDate(expRaw),
            sex: l2[7] === "M" ? "M" : l2[7] === "F" ? "F" : "X",
            surname,
            names,
            checksums: {
                date_of_birth: dobOk,
                expiration_date: expOk,
                composite: compositeOk,
                all_ok: dobOk && expOk && compositeOk,
            },
        };
    }

    return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const input = items[0].json;

// Cas d'erreur remontée par le microservice
if (input.error) {
    return [{
        json: {
            valid: false,
            reason: "ocr_service_error",
            message: input.error,
        }
    }];
}

const rawText = (input.text || "").trim();
const pageCount = input.page_count ?? null;

// Texte vide = OCR n'a rien retourné
if (!rawText) {
    return [{
        json: {
            valid: false,
            reason: "empty_ocr_output",
            message: "Aucun texte extrait par le moteur OCR",
            page_count: pageCount,
        }
    }];
}

// Tentative de parsing MRZ
const mrz = parseMrzTD1(rawText);

if (mrz) {
    return [{
        json: {
            valid: true,
            method: "doctr_mrz",
            all_checksums_ok: mrz.checksums.all_ok,
            confidence: mrz.checksums.all_ok ? "high" : "medium",

            // Données structurées
            card_number: mrz.card_number,
            surname: mrz.surname,
            names: mrz.names,
            date_of_birth: mrz.date_of_birth,
            expiration_date: mrz.expiration_date,
            nationality: mrz.nationality,
            sex: mrz.sex,

            // MRZ brute (utile pour debug ou double-check)
            mrz_line1: mrz.mrz_line1,
            mrz_line2: mrz.mrz_line2,
            mrz_line3: mrz.mrz_line3,

            checksums: mrz.checksums,
            page_count: pageCount,
            raw_text: rawText,         // conservé pour audit / fallback LLM
        }
    }];
}

// MRZ non trouvée → retour texte brut pour traitement manuel ou nœud LLM suivant
return [{
    json: {
        valid: false,
        reason: "mrz_not_found",
        message: "MRZ TD1 non détectée dans le texte OCR — traitement manuel requis",
        page_count: pageCount,
        raw_text: rawText,   // texte disponible pour un nœud LLM ou regex custom
    }
}];