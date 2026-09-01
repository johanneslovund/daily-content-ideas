FROM alpine:3.20

RUN apk add --no-cache curl ca-certificates bash && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64) CF_ARCH=amd64 ;; \
      aarch64) CF_ARCH=arm64 ;; \
      armv7l) CF_ARCH=arm ;; \
      *) CF_ARCH=amd64 ;; \
    esac && \
    curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
