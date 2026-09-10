# Sandboxed, disposable browser session image.
# X server + window manager + Chromium + VNC exporter + a small control agent.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:1 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    HOME=/home/surf

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      dbus-x11 \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-core \
      nodejs \
      openbox \
      procps \
      x11-utils \
      x11vnc \
      xclip \
      xdotool \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged session user. The container itself is the sandbox boundary.
RUN useradd --create-home --shell /bin/bash --uid 1000 surf \
    && mkdir -p /home/surf/.vnc /home/surf/profile \
    && chown -R surf:surf /home/surf

COPY --chown=surf:surf openbox-rc.xml /home/surf/.config/openbox/rc.xml
COPY --chown=surf:surf agent.mjs /opt/agent/agent.mjs
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER surf
WORKDIR /home/surf

# 5900 = raw VNC (RFB), 6070 = control agent HTTP. Neither is published publicly;
# the orchestrator reaches them over a private Docker network.
EXPOSE 5900 6070

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:6070/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
