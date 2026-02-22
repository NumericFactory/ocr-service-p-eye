#!/usr/bin/env python3
"""
OCR worker using Doctr.
Usage: python ocr_worker.py <pdf_path> [lang]
Outputs JSON to stdout — logs forcés sur stderr uniquement.
"""

import sys
import json
import os
import logging

# ── Rediriger TOUS les logs vers stderr avant tout import ─────────────────────
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["DOCTR_MULTIPROCESSING_DISABLE"] = "TRUE"

# Forcer les loggers Python vers stderr
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

# Monkey-patch print de Doctr/tqdm vers stderr
import builtins
_real_print = builtins.print
def _stderr_print(*args, **kwargs):
    kwargs.setdefault("file", sys.stderr)
    _real_print(*args, **kwargs)
builtins.print = _stderr_print

# ── Imports après redirection ──────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        _real_print(json.dumps({"error": "Usage: ocr_worker.py <pdf_path> [lang]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]

    try:
        # tqdm vers stderr
        import tqdm
        tqdm.tqdm = lambda *a, **kw: (iter(a[0]) if a else iter([]))

        from doctr.io import DocumentFile
        from doctr.models import ocr_predictor
    except ImportError as e:
        _real_print(json.dumps({"error": f"Doctr import failed: {str(e)}"}))
        sys.exit(1)

    try:
        doc = DocumentFile.from_pdf(pdf_path)
        page_count = len(doc)

        model = ocr_predictor(
            det_arch="db_resnet50",
            reco_arch="crnn_vgg16_bn",
            pretrained=True,
            assume_straight_pages=False,
            straighten_pages=True,
        )

        result = model(doc)

        pages_text = []
        for page in result.pages:
            lines = []
            for block in page.blocks:
                for line in block.lines:
                    words = [w.value for w in line.words]
                    lines.append(" ".join(words))
            pages_text.append("\n".join(lines))

        full_text = "\n\n--- PAGE BREAK ---\n\n".join(pages_text).strip()

        # Seule ligne sur stdout : le JSON
        _real_print(json.dumps({"text": full_text, "page_count": page_count}))

    except Exception as e:
        _real_print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()