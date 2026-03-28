#!/usr/bin/env bash
# Run on the EC2 instance to authenticate kiro-cli.
# Called from an interactive SSM session.
#
# Usage: /opt/nanoclaw/scripts/kiro-auth-remote.sh

set -euo pipefail

KIRO_CLI="/home/ec2-user/.local/bin/kiro-cli"

if [[ ! -x "$KIRO_CLI" ]]; then
  echo "kiro-cli not found. Installing..."
  sudo -u ec2-user bash -c 'curl -fsSL https://cli.kiro.dev/install | bash'
fi

# Ensure auth dir is symlinked to persistent volume
DATA_DIR="/opt/nanoclaw-data"
if [[ -d "$DATA_DIR" ]]; then
  sudo mkdir -p "$DATA_DIR/.kiro-cli-auth"
  sudo chown ec2-user:ec2-user "$DATA_DIR/.kiro-cli-auth"
  sudo -u ec2-user mkdir -p /home/ec2-user/.local/share
  if [[ ! -L /home/ec2-user/.local/share/kiro-cli ]]; then
    sudo rm -rf /home/ec2-user/.local/share/kiro-cli
    sudo -u ec2-user ln -sfn "$DATA_DIR/.kiro-cli-auth" /home/ec2-user/.local/share/kiro-cli
  fi
fi

echo ""
echo "Starting kiro-cli device-flow login..."
echo "A URL and code will appear. Open the URL in your browser and enter the code."
echo ""

sudo -u ec2-user "$KIRO_CLI" login --device-flow

echo ""

# Verify
if sudo -u ec2-user "$KIRO_CLI" --version &>/dev/null; then
  echo "kiro-cli authenticated successfully."
  echo ""
  echo "Restarting NanoClaw service..."
  sudo systemctl restart nanoclaw
  sleep 3
  if systemctl is-active --quiet nanoclaw; then
    echo "Service is running."
  else
    echo "WARNING: Service failed to start. Check: journalctl -u nanoclaw -n 30"
  fi
else
  echo "WARNING: kiro-cli auth may have failed. Try again."
fi
