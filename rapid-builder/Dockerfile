# rclone with the Bunny.net storage backend, built from the PR branch until
# https://github.com/rclone/rclone/pull/9261 is merged and released.
FROM golang:1.26-trixie AS rclone
ARG RCLONE_REPO=https://github.com/istr/rclone.git
ARG RCLONE_COMMIT=ffc797f1db617e1c65ac688d7f228faec5c2cfae
RUN git clone --branch bunny-api-backend "$RCLONE_REPO" /src \
 && git -C /src checkout "$RCLONE_COMMIT"
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /rclone .

# Base application image with all dependencies
FROM node:26-trixie-slim AS base
ARG RAPIDTOOLS_DEB=https://github.com/beyond-all-reason/RapidTools/releases/download/v0.3.0/rapidtools_0.3.0-0%2Bdebian13_amd64.deb

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && curl -fsSL -o /tmp/rapidtools.deb "$RAPIDTOOLS_DEB" \
 && apt-get install -y --no-install-recommends /tmp/rapidtools.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/rapidtools.deb
COPY --from=rclone /rclone /usr/local/bin/rclone

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Image with the local fakes: the sandbox runs from it, and so do the e2e
# tests, which assemble their environment out of the same dev/ modules.
FROM base AS dev
COPY src ./src
COPY dev ./dev
# Writable, since git and rclone both want a home to look for config.
ENV HOME=/tmp
USER node
CMD ["node", "dev/main.ts"]

# Image for running e2e tests
FROM dev AS e2e
COPY test ./test
CMD ["node", "--test", "--test-timeout=300000", "test/e2e.ts"]

# Last, so `docker build .` and compose's `build: .` produce the service.
FROM base AS runtime
RUN mkdir /data && chown node:node /data
COPY src ./src
USER node
ENV NODE_ENV=production PORT=8080 METRICS_PORT=9464
EXPOSE 8080 9464
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS "http://127.0.0.1:$PORT/healthz" || exit 1

CMD ["node", "src/main.ts"]
