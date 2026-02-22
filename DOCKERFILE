# ─── Stage 1 : deps ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# ─── Stage 2 : runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ocrmypdf \
    unpaper \
    tesseract-ocr \
    tesseract-ocr-fra \
    tesseract-ocr-eng \
    tesseract-ocr-osd \
    poppler-utils \
    ghostscript \
    qpdf \
    ca-certificates \
    fonts-dejavu-core \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# PassportEye et ses dépendances Python
RUN python3 -m pip install --break-system-packages --no-cache-dir \
    passporteye \
    pillow \
    numpy \
    scipy \
    scikit-image

RUN groupadd --gid 1001 appgroup && \
    useradd  --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./

RUN chown -R appuser:appgroup /app
USER appuser

STOPSIGNAL SIGTERM

# Coolify injecte PORT=3000 — on hardcode 3000 ici pour matcher
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3000/health | grep -q '"ok":true' || exit 1

CMD ["node", "server.js"]