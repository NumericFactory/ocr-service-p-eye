#!/usr/bin/env python3
"""Pre-download ALL Doctr models used at runtime."""
import os
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

from doctr.models import ocr_predictor

# Télécharge tous les modèles y compris orientation (assume_straight_pages=False)
print("Downloading detection + recognition models...")
ocr_predictor(
    det_arch="db_resnet50",
    reco_arch="crnn_vgg16_bn",
    pretrained=True,
    assume_straight_pages=False,
    straighten_pages=True,
)
print("All models downloaded successfully.")