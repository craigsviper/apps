# ╔══════════════════════════════════════════════════════════════╗
# ║  RSW Field App v73.142 — Multi-stage Build                      ║
# ║  Stage 1: Node.js  → builds React/Vite app                  ║
# ║  Stage 2: Nginx    → serves on HTTPS port 8050              ║
# ║                                                             ║
# ║  HTTPS required for GPS/camera on phones & tablets          ║
# ╚══════════════════════════════════════════════════════════════╝

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency files first (better layer caching)
COPY package.json ./
RUN npm install --legacy-peer-deps

# Copy source files and build
COPY . .
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────
FROM nginx:alpine

LABEL maintainer="RSW Field App"
LABEL description="RSW Field App v73.142 - Site & Road Inspections + Road Sweeping"
LABEL version="73.142.0"

# Generate self-signed SSL cert (GPS & camera require HTTPS on mobile devices)
RUN apk add --no-cache openssl curl \
 && mkdir -p /etc/nginx/ssl \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/nginx/ssl/rsw-key.pem \
      -out    /etc/nginx/ssl/rsw-cert.pem \
      -subj "/C=NZ/ST=Waikato/L=Hamilton/O=RSW Field App/CN=rsw-app" \
      -addext "subjectAltName=IP:127.0.0.1,IP:192.168.1.7,IP:192.168.1.1,IP:192.168.1.2,IP:192.168.1.3,IP:192.168.1.4,IP:192.168.1.5,IP:192.168.1.6,IP:192.168.1.8,IP:192.168.1.9,IP:192.168.1.10,IP:192.168.0.1,IP:192.168.0.100,IP:10.0.0.1,IP:10.0.0.2,IP:10.0.1.1,DNS:localhost,DNS:rsw-app" \
 && chmod 600 /etc/nginx/ssl/rsw-key.pem \
 && echo "✅ SSL certificate generated"

COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from Stage 1 (dist/ folder from vite build)
COPY --from=builder /app/dist /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsk https://127.0.0.1:8050/ > /dev/null || exit 1

EXPOSE 8050

CMD ["nginx", "-g", "daemon off;"]
