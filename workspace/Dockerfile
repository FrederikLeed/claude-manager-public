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
    && rm -rf /var/lib/apt/lists/*

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

# Node.js 22 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Global npm packages
RUN npm install -g @anthropic-ai/claude-code typescript ts-node https-proxy-agent

# Create non-root user
RUN useradd -m -s /bin/bash claude \
    && echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

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

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
