FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    tmux \
    vim \
    nano \
    jq \
    ripgrep \
    fd-find \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    gnupg \
    sudo \
    unzip \
    zip \
    openssh-client \
    apt-transport-https \
    software-properties-common \
    dnsutils \
    iputils-ping \
    net-tools \
    iptables \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with FIXED uid/gid 1001 — workspace volumes and host binds are
# owned by 1001. Created before any package that adds system groups (the
# 1Password CLI creates 'onepassword-cli'), which would otherwise take gid 1001.
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g 1001 claude \
    && useradd -m -u 1001 -g 1001 -s /bin/bash claude \
    && echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && id claude

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI (for container management access)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# 1Password CLI (op) — instances read secrets via a service account token
# (OP_SERVICE_ACCOUNT_TOKEN, injected by the manager). Official apt repo + debsig policy.
RUN curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
      > /etc/apt/sources.list.d/1password.list \
    && mkdir -p /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
      -o /etc/debsig/policies/AC2D62742012EA22/1password.pol \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor -o /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
    && apt-get update && apt-get install -y 1password-cli \
    && rm -rf /var/lib/apt/lists/* \
    && op --version

# Node.js 22 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# gitleaks — secret scanner used by the global pre-commit hook (blocks committing
# secrets at the source). Pinned, multi-arch.
RUN GL_VER=8.21.2 \
    && ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in amd64) GLA=x64 ;; arm64) GLA=arm64 ;; *) GLA=x64 ;; esac \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GL_VER}/gitleaks_${GL_VER}_linux_${GLA}.tar.gz" \
       -o /tmp/gitleaks.tgz \
    && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
    && chmod +x /usr/local/bin/gitleaks \
    && rm -f /tmp/gitleaks.tgz \
    && gitleaks version

# Global npm packages.
# The ADD fetches the npm registry's "latest" metadata for claude-code,
# which changes every time a new version is published — that invalidates
# this layer's cache automatically, so rebuilds always pick up the newest
# CLI (and its newest default model) without needing --no-cache.
ADD https://registry.npmjs.org/@anthropic-ai/claude-code/latest /tmp/claude-code-latest.json
RUN npm install -g @anthropic-ai/claude-code@latest typescript ts-node https-proxy-agent \
    && rm -f /tmp/claude-code-latest.json

# Fail the build if the claude user's ids drifted
RUN test "$(id -u claude):$(id -g claude)" = "1001:1001"

# Copy config files (strip CRLF in case git autocrlf converted them on Windows)
COPY config/tmux.conf /home/claude/.tmux.conf
RUN sed -i 's/\r$//' /home/claude/.tmux.conf \
    && chown claude:claude /home/claude/.tmux.conf

# Create proxy bootstrap script for Node.js proxy support (patches https.globalAgent + fetch)
COPY scripts/proxy-bootstrap.js /home/claude/.proxy-bootstrap.js
RUN sed -i 's/\r$//' /home/claude/.proxy-bootstrap.js \
    && chown claude:claude /home/claude/.proxy-bootstrap.js

# Copy cm-access CLI tool (query/request network access from manager)
COPY scripts/cm-access /usr/local/bin/cm-access
RUN sed -i 's/\r$//' /usr/local/bin/cm-access \
    && chmod +x /usr/local/bin/cm-access

# Copy cm-notify hook (reports Stop/Notification + token usage to the manager)
COPY scripts/cm-notify /usr/local/bin/cm-notify
RUN sed -i 's/\r$//' /usr/local/bin/cm-notify \
    && chmod +x /usr/local/bin/cm-notify

# Boot-time Claude autostart + per-instance session tracking (resume after restart)
COPY scripts/cm-autostart scripts/cm-session-track /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/cm-autostart /usr/local/bin/cm-session-track \
    && chmod +x /usr/local/bin/cm-autostart /usr/local/bin/cm-session-track

# Managed Claude Code settings — highest precedence, NOT overridden by a
# bind-mount over /home/claude/.claude. Registers the cm-notify Stop/Notification
# hooks for every session in this image.
COPY config/managed-settings.json /etc/claude-code/managed-settings.json
# Managed CLAUDE.md — loaded into every session (1Password + network guidance).
# The shared ~/.claude mount can't carry it: it's per-host and not in the repo.
COPY config/CLAUDE.md /etc/claude-code/CLAUDE.md
RUN sed -i 's/\r$//' /etc/claude-code/managed-settings.json /etc/claude-code/CLAUDE.md

# Global git pre-commit hook — blocks committing secrets (gitleaks) in every repo
COPY scripts/git-pre-commit /etc/git-hooks/pre-commit
RUN sed -i 's/\r$//' /etc/git-hooks/pre-commit \
    && chmod +x /etc/git-hooks/pre-commit

# Copy entrypoint
COPY scripts/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh \
    && chmod +x /entrypoint.sh

# Working directory
WORKDIR /workspace
RUN chown claude:claude /workspace

USER claude

# Skip permission prompts — these are sandboxed containers with no direct internet
# Activate proxy bootstrap for Node.js (patches https.globalAgent) if proxy is configured
RUN echo 'alias claude="claude --dangerously-skip-permissions"' >> /home/claude/.bashrc \
    && echo '[ -n "$HTTPS_PROXY" ] && [ -f "$HOME/.proxy-bootstrap.js" ] && export NODE_PATH="/usr/lib/node_modules:${NODE_PATH:-}" && export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }-r $HOME/.proxy-bootstrap.js"' >> /home/claude/.bashrc

# Route every repo's hooks to the global hook dir so the secret-blocking
# pre-commit applies without per-repo `git init` setup.
RUN git config --global core.hooksPath /etc/git-hooks

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
