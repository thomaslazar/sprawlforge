FROM mcr.microsoft.com/devcontainers/typescript-node:22

# python3: needed by the peon-ping installer.
# jq: used by post-create.sh to register the statusline.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (native installer) + peon-ping both install to ~/.local/bin
ENV PATH="/home/node/.local/bin:${PATH}"

USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

# peon-ping: install as node user so hooks land in /home/node/.claude/.
# REMOTE_CONTAINERS tricks the installer into devcontainer mode so it
# skips the audio-player check (audio goes through the relay on the host).
# The installer has no --no-packs flag and always downloads default sound
# packs; delete them in the same layer — devcontainer.json bind-mounts the
# host's ~/.openpeon/packs over that dir at runtime anyway.
USER node
RUN export REMOTE_CONTAINERS=true \
    && curl -fsSL https://peonping.com/install | bash \
    && rm -rf /home/node/.claude/hooks/peon-ping/packs
USER root
