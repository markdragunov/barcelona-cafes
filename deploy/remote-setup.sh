#!/usr/bin/env bash
# Install Docker + Compose plugin on Ubuntu droplet; open firewall.
set -euo pipefail

REMOTE="${REMOTE:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ -z "$REMOTE" ]]; then
  echo "Set REMOTE=user@YOUR_DROPLET_IP (and optionally SSH_KEY)." >&2
  exit 1
fi
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

echo "Setting up ${REMOTE}..."
"${SSH[@]}" "$REMOTE" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

docker --version
docker compose version

# Swap if missing (helps 1–2 GB droplets)
if ! swapon --show | grep -q .; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get install -y -qq ufw sqlite3 >/dev/null
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Stop legacy bare-metal service if present (Docker replaces it)
if systemctl list-unit-files | grep -q barcelona-cafes.service; then
  systemctl disable --now barcelona-cafes.service || true
fi

# Close old direct app port from public if open
ufw delete allow 3847/tcp 2>/dev/null || true

mkdir -p /opt/barcelona-cafes /opt/barcelona-cafes/backups /var/lib/barcelona-cafes-data
echo "remote setup complete"
REMOTE
