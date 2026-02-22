// ─── Noeud Code n8n ───────────────────────────────────────────────────────────
// Input  : output du endpoint /verify-id du microservice
// Output : données structurées de la CNI + statut de validation
// ─────────────────────────────────────────────────────────────────────────────

const input = items[0].json;

// Cas d'erreur HTTP (le microservice a renvoyé une 4xx/5xx)
if (input.error) {
    return [{
        json: {
            valid: false,
            reason: "microservice_error",
            message: input.error,
        }
    }];
}

// Cas PassportEye réussi — données riches avec checksums
if (input.valid && input.method === "passporteye") {
    return [{
        json: {
            valid: true,
            method: "passporteye",
            confidence: input.valid_score,         // 0-100
            all_checksums_ok: input.all_checksums_ok,
            card_number: input.card_number,
            surname: input.surname,
            names: input.names,
            date_of_birth: input.date_of_birth,    // format YYMMDD
            expiration_date: input.expiration_date,
            nationality: input.nationality,
            sex: input.sex,
            mrz_line1: input.mrz_line1,
            mrz_line2: input.mrz_line2,
        }
    }];
}

// Cas fallback Tesseract réussi — données partielles sans checksums
if (input.valid && input.method === "tesseract_fallback") {
    return [{
        json: {
            valid: true,
            method: "tesseract_fallback",
            confidence: null,          // non disponible sans PassportEye
            all_checksums_ok: null,    // non disponible sans PassportEye
            card_number: input.card_number,
            mrz_line2: input.mrz_line2,
            // Champs non disponibles en fallback Tesseract
            surname: null,
            names: null,
            date_of_birth: null,
            expiration_date: null,
            nationality: null,
            sex: null,
        }
    }];
}

// Cas d'échec de validation
return [{
    json: {
        valid: false,
        reason: input.reason || "unknown",
        message: input.message || "Validation échouée",
        card_number: input.card_number || null,
        mrz_line2: input.mrz_line2 || null,
    }
}];