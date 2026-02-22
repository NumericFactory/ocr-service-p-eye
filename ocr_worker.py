#!/usr/bin/env python3
"""
OCR worker using Doctr.
Usage: python ocr_worker.py <pdf_path> [lang]
Outputs JSON to stdout: { "text": "...", "page_count": N }
"""

import sys
import json
import os

# Silence TF/torch logs
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["DOCTR_MULTIPROCESSING_DISABLE"] = "TRUE"

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr_worker.py <pdf_path> [lang]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    # Doctr handles fra/eng natively; lang param kept for compatibility
    # lang = sys.argv[2] if len(sys.argv) > 2 else "fra"

    try:
        from doctr.io import DocumentFile
        from doctr.models import ocr_predictor
    except ImportError as e:
        print(json.dumps({"error": f"Doctr import failed: {str(e)}"}))
        sys.exit(1)

    try:
        # Load PDF
        doc = DocumentFile.from_pdf(pdf_path)
        page_count = len(doc)

        # Load model (det + reco, pretrained)
        # assume_straight_pages=False handles rotated/skewed ID cards
        model = ocr_predictor(
            det_arch="db_resnet50",
            reco_arch="crnn_vgg16_bn",
            pretrained=True,
            assume_straight_pages=False,
            straighten_pages=True,
        )

        result = model(doc)

        # Export to text, preserving rough layout
        pages_text = []
        for page in result.pages:
            lines = []
            for block in page.blocks:
                for line in block.lines:
                    words = [w.value for w in line.words]
                    lines.append(" ".join(words))
            pages_text.append("\n".join(lines))

        full_text = "\n\n--- PAGE BREAK ---\n\n".join(pages_text).strip()

        print(json.dumps({
            "text": full_text,
            "page_count": page_count,
        }))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()