#!/bin/bash
# deploy/vps-setup.sh
# Tenet (TEN) — VPS node setup script
# Tested on: Ubuntu 22.04 LTS (AWS t3.small / DigitalOcean Droplet 2GB)
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/you/tenet/main/deploy/vps-setup.sh | bash
#   OR: scp + bash vps-setup.sh

set -e

TENET_USER="tenet"
TENET_DIR="/var/tenet"
REPO_URL="${REPO_URL:-https://github.com/you/tenet.git}"   # replace with real URL
NODE_VERSION="20"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║      Tenet (TEN) — VPS Node Setup           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. System dependencies ──────────────────────────────────────────────────
echo "[1/8] Installing system dependencies…"
apt-get update -qq
apt-get install -y -qq git curl build-essential ufw fail2ban

# ── 2. Node.js 20 ──────────────────────────────────────────────────────────
echo "[2/8] Installing Node.js ${NODE_VERSION}…"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
echo "   node: $(node --version)  npm: $(npm --version)"

# ── 3. Create tenet user ────────────────────────────────────────────────────
echo "[3/8] Creating system user '${TENET_USER}'…"
id -u "$TENET_USER" &>/dev/null || useradd -r -s /bin/bash -d "$TENET_DIR" "$TENET_USER"
mkdir -p "$TENET_DIR"
chown "$TENET_USER:$TENET_USER" "$TENET_DIR"

# ── 4. Clone / update repo ──────────────────────────────────────────────────
echo "[4/8] Cloning Tenet repo…"
if [ -d "$TENET_DIR/app/.git" ]; then
  su "$TENET_USER" -c "cd $TENET_DIR/app && git pull --quiet"
else
  su "$TENET_USER" -c "git clone --depth 1 $REPO_URL $TENET_DIR/app"
fi

cd "$TENET_DIR/app"
su "$TENET_USER" -c "cd $TENET_DIR/app && npm install --omit=dev --quiet"

# ── 5. Configure env ────────────────────────────────────────────────────────
echo "[5/8] Setting up .env…"
VALIDATOR_ID="${VALIDATOR_ID:-1}"
if [ ! -f "$TENET_DIR/app/.env" ]; then
  cp "$TENET_DIR/app/.env.validator${VALIDATOR_ID}" "$TENET_DIR/app/.env"
  echo "   Copied .env.validator${VALIDATOR_ID} → .env"
  echo "   ⚠  Edit $TENET_DIR/app/.env to set PEERS before starting"
fi

# ── 6. Systemd service ──────────────────────────────────────────────────────
echo "[6/8] Creating systemd service…"
cat > /etc/systemd/system/tenet.service <<EOF
[Unit]
Description=Tenet (TEN) Validator Node
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${TENET_USER}
WorkingDirectory=${TENET_DIR}/app
ExecStart=/usr/bin/node ${TENET_DIR}/app/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tenet
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tenet
echo "   Service registered. Start with: systemctl start tenet"

# ── 7. Firewall ─────────────────────────────────────────────────────────────
echo "[7/8] Configuring firewall (ufw)…"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh
ufw allow 6001/tcp   comment "Tenet P2P"
ufw allow 3000/tcp   comment "Tenet RPC"
ufw --force enable >/dev/null
echo "   Open ports: 22 (SSH), 6001 (P2P), 3000 (RPC)"

# ── 8. Nginx reverse proxy (optional) ──────────────────────────────────────
echo "[8/8] Skipping nginx setup (run deploy/setup-nginx.sh to enable HTTPS)"
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║             Setup Complete!                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║ 1. Edit: ${TENET_DIR}/app/.env               ║"
echo "║    Set PEERS=ws://other-nodes-ip:6001        ║"
echo "║ 2. Start: systemctl start tenet              ║"
echo "║ 3. Logs:  journalctl -u tenet -f             ║"
echo "║ 4. RPC:   curl localhost:3000/health         ║"
echo "║ 5. Explorer: http://YOUR_IP:3000/explorer.html ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
