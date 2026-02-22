#!/usr/bin/env python3
"""
OCR worker persistant — lit des requêtes JSON sur stdin, écrit des réponses JSON sur stdout.
Modèle Doctr chargé UNE SEULE FOIS au démarrage du process.

Protocole :
  stdin  → {"id": "abc", "pdf_path": "/tmp/input.pdf"}
  stdout → {"id": "abc", "text": "...", "page_count": N}
         | {"id": "abc", "error": "message"}
  stdout → {"ready": true}  (au démarrage, une seule fois)
"""

import sys
import json
import os
import logging
import traceback
import builtins

# ── Tout vers stderr avant imports ────────────────────────────────────────────
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["DOCTR_MULTIPROCESSING_DISABLE"] = "TRUE"
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

_orig_print = builtins.print
def _stderr_print(*args, **kwargs):
    kwargs.setdefault("file", sys.stderr)
    _orig_print(*args, **kwargs)
builtins.print = _stderr_print

def emit(obj):
    _orig_print(json.dumps(obj, ensure_ascii=False), file=sys.stdout, flush=True)

# ── Chargement modèle ─────────────────────────────────────────────────────────

def load_model():
    _orig_print(f"[worker pid={os.getpid()}] Loading Doctr model...", file=sys.stderr, flush=True)
    from doctr.io import DocumentFile
    from doctr.models import ocr_predictor
    model = ocr_predictor(
        det_arch="db_resnet50",
        reco_arch="crnn_vgg16_bn",
        pretrained=True,
        assume_straight_pages=False,
        straighten_pages=True,
    )
    _orig_print(f"[worker pid={os.getpid()}] Ready.", file=sys.stderr, flush=True)
    return model, DocumentFile

# ── OCR ───────────────────────────────────────────────────────────────────────

def ocr_pdf(model, DocumentFile, pdf_path):
    doc = DocumentFile.from_pdf(pdf_path)
    page_count = len(doc)
    result = model(doc)
    pages_text = []
    for page in result.pages:
        lines = []
        for block in page.blocks:
            for line in block.lines:
                lines.append(" ".join(w.value for w in line.words))
        pages_text.append("\n".join(lines))
    full_text = "\n\n--- PAGE BREAK ---\n\n".join(pages_text).strip()
    return full_text, page_count

# ── Boucle principale ─────────────────────────────────────────────────────────

def main():
    try:
        model, DocumentFile = load_model()
    except Exception as e:
        emit({"ready": False, "error": f"Model load failed: {e}"})
        sys.exit(1)

    emit({"ready": True})

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        req_id = None
        try:
            req = json.loads(raw_line)
            req_id = req.get("id")
            text, page_count = ocr_pdf(model, DocumentFile, req["pdf_path"])
            emit({"id": req_id, "text": text, "page_count": page_count})
        except json.JSONDecodeError as e:
            emit({"id": req_id, "error": f"Invalid JSON: {e}"})
        except KeyError as e:
            emit({"id": req_id, "error": f"Missing field: {e}"})
        except Exception as e:
            _orig_print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit({"id": req_id, "error": str(e)})

if __name__ == "__main__":
    main()