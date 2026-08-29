FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

RUN mkdir -p /data/backups /certs && apk add --no-cache curl openssl tzdata

VOLUME ["/data"]
VOLUME ["/certs"]

EXPOSE 8055
EXPOSE 8056

ENV NODE_ENV=production
ENV DATA_DIR=/data
# v73.58: Node's fetch() (undici) tries IPv6 first by default; most Docker
# containers have no outbound IPv6 route, so it fails fast with a generic
# "fetch failed" instead of falling back to IPv4 the way curl/wget do.
# This is what broke updateRoadsFromOverpass() even though wget could
# reach overpass-api.de fine from inside the same container.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsk https://localhost:8055/health || exit 1

CMD ["node", "server.js"]
