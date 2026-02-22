# ─── Stage 1 : Node deps ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS node-deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# ─── Stage 2 : Python deps (Doctr + torch CPU) ────────────────────────────────
FROM python:3.11-slim-bookworm AS python-deps

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# PyTorch CPU-only (pas de CUDA = image beaucoup plus légère)
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Doctr avec backend torch
RUN pip install "python-doctr[torch]"

# Pré-téléchargement des modèles via script
COPY download_models.py /tmp/download_models.py
RUN python3 /tmp/download_models.py

# ─── Stage 3 : final runtime ──────────────────────────────────────────────────
# Base Python : évite les problèmes de libpython3.11.so manquante
FROM python:3.11-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DOCTR_CACHE_DIR=/home/appuser/.cache/doctr \
    TF_CPP_MIN_LOG_LEVEL=3 \
    PYTHONUNBUFFERED=1

# System libs + Node.js 20 via nodesource
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    poppler-utils \
    ca-certificates \
    curl \
    wget \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Packages Python (torch + doctr) depuis python-deps
COPY --from=python-deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages

# Modèles Doctr pré-téléchargés
COPY --from=python-deps /root/.cache/doctr /home/appuser/.cache/doctr

# App user
RUN groupadd --gid 1001 appgroup && \
    useradd  --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser \
    && chown -R appuser:appgroup /home/appuser/.cache

WORKDIR /app

# Node deps + app files
COPY --from=node-deps /app/node_modules ./node_modules
COPY server.js ocr_worker.py ./

RUN chown -R appuser:appgroup /app
USER appuser

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -qO- http://localhost:3000/health | grep -q '"ok":true' || exit 1

CMD ["node", "server.js"]