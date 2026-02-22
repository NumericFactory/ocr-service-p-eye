#!/usr/bin/env python3
"""Pre-download Doctr models at Docker build time."""
from doctr.models import ocr_predictor
ocr_predictor(det_arch="db_resnet50", reco_arch="crnn_vgg16_bn", pretrained=True)
print("Models downloaded successfully.")