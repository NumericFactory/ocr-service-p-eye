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

# System libs needed by Doctr / OpenCV / pdf2image
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch CPU-only first (keeps image small — no CUDA)
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Install Doctr with torch backend
RUN pip install "python-doctr[torch]"

# Pré-téléchargement des modèles via script (évite le parse error Dockerfile)
COPY download_models.py /tmp/download_models.py
RUN python3 /tmp/download_models.py

# ─── Stage 3 : final runtime ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # Tell Python where to find pre-downloaded Doctr models
    DOCTR_CACHE_DIR=/home/appuser/.cache/doctr \
    # Silence TF/Torch verbose logs
    TF_CPP_MIN_LOG_LEVEL=3 \
    PYTHONUNBUFFERED=1

# Runtime system libs (same as python-deps stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-distutils \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    poppler-utils \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Copy Python packages from python-deps
COPY --from=python-deps /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=python-deps /usr/local/bin/python3.11 /usr/local/bin/python3.11
RUN ln -sf /usr/local/bin/python3.11 /usr/local/bin/python3

# Copy pre-downloaded Doctr models
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