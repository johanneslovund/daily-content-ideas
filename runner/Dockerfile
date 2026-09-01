FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ARG RUNNER_VERSION=2.319.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates jq git docker.io sudo openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (needed for the lead-finder automation workflow).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Docker Compose v2 CLI plugin (static binary, arch-detected).
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) COMPOSE_ARCH="x86_64" ;; \
      arm64) COMPOSE_ARCH="aarch64" ;; \
      *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose; \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# GitHub Actions runner (static binary, arch-detected).
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) RUNNER_ARCH="x64" ;; \
      arm64) RUNNER_ARCH="arm64" ;; \
      *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /actions-runner; \
    cd /actions-runner; \
    curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
      -o runner.tar.gz; \
    tar xzf runner.tar.gz; \
    rm runner.tar.gz; \
    ./bin/installdependencies.sh

WORKDIR /actions-runner
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
