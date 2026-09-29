#!/bin/bash
# cloud-init user-data for one SYNTH worker VM. No secrets here: user-data is readable from the VM's metadata
# service and stays on the Vultr account. Code + the worker's keys arrive later over SSH (vms.ts push).
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y unzip curl ca-certificates fonts-noto-core fonts-noto-color-emoji fonts-liberation

useradd -m -s /bin/bash synth || true
su - synth -c 'curl -fsSL https://bun.sh/install | bash'
ln -sf /home/synth/.bun/bin/bun /usr/local/bin/bun
ln -sf /home/synth/.bun/bin/bunx /usr/local/bin/bunx

# Playwright's installer spawns `node` itself (bunx --bun doesn't cover that), so a real Node goes in first
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz | tar -xJ -C /opt
for b in node npm npx; do ln -sf /opt/node-v22.22.0-linux-x64/bin/$b /usr/local/bin/$b; done

# headless Chromium: system libraries as root, the browser itself in synth's cache (re-run after push so the
# browser build matches the repo's Playwright version, if it pins one)
HOME=/root bunx playwright install-deps chromium
su - synth -c 'bunx playwright install chromium'

mkdir -p /opt/synth /etc/synth /var/lib/synth
chown synth:synth /opt/synth /var/lib/synth
chmod 700 /etc/synth

cat > /etc/systemd/system/synth-worker.service <<'UNIT'
[Unit]
Description=SYNTH worker (one Band agent)
After=network-online.target
Wants=network-online.target

[Service]
User=synth
WorkingDirectory=/opt/synth
EnvironmentFile=/etc/synth/worker.env
ExecStart=/usr/local/bin/bun src/worker.ts
Restart=on-failure
RestartSec=5
# the Band socket keeps bun alive past SIGTERM; don't wait 90 s on stop/sync
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

touch /var/lib/synth-ready
