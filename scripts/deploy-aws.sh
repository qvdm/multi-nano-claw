#!/usr/bin/env bash
# Deploy NanoClaw to AWS EC2 via SSM Run Command.
# No SSH or inbound ports required.
#
# Modes:
#   Git pull (default):  ./scripts/deploy-aws.sh [instance-id]
#   Local code (tar+S3): ./scripts/deploy-aws.sh --local [instance-id]
#
# Options:
#   --local              Deploy local working directory instead of git pull
#   --region REGION      AWS region (default: $AWS_REGION or us-east-1)
#   --profile PROFILE    AWS CLI profile
#
# Environment:
#   NANOCLAW_INSTANCE_ID  Instance ID (alternative to positional arg)
#   AWS_REGION            Default region

set -euo pipefail

# --- Parse arguments ---
LOCAL_MODE=false
SKIP_CONTAINER=false
REGION=""
PROFILE=""
INSTANCE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      LOCAL_MODE=true
      shift
      ;;
    --skip-container)
      SKIP_CONTAINER=true
      shift
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--local] [--skip-container] [--region REGION] [--profile PROFILE] [instance-id]"
      echo ""
      echo "Modes:"
      echo "  (default)  git pull on instance (changes must be pushed to GitHub)"
      echo "  --local    tar local code, upload via S3, extract on instance"
      echo ""
      echo "Options:"
      echo "  --skip-container  Skip Docker container build (for kiro host mode)"
      echo "  --region          AWS region (default: \$AWS_REGION or us-east-1)"
      echo "  --profile         AWS CLI profile to use"
      exit 0
      ;;
    *)
      INSTANCE_ID="$1"
      shift
      ;;
  esac
done

INSTANCE_ID="${INSTANCE_ID:-${NANOCLAW_INSTANCE_ID:-}}"
REGION="${REGION:-${AWS_REGION:-us-east-1}}"

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Error: Instance ID required. Pass as argument or set NANOCLAW_INSTANCE_ID."
  exit 1
fi

# Build AWS CLI flags
AWS_OPTS="--region $REGION"
[[ -n "$PROFILE" ]] && AWS_OPTS="$AWS_OPTS --profile $PROFILE"

# Container build command (conditional)
if $SKIP_CONTAINER; then
  CONTAINER_CMD="echo Skipping container build (--skip-container)"
else
  CONTAINER_CMD="if command -v docker &>/dev/null && docker info &>/dev/null; then cd container && ./build.sh && cd ..; else echo Skipping container build; fi"
fi

echo "Deploying NanoClaw to $INSTANCE_ID in $REGION..."

# --- Local mode: tar + S3 ---
if $LOCAL_MODE; then
  # Find project root (parent of scripts/)
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

  ACCOUNT_ID=$(aws sts get-caller-identity $AWS_OPTS --query Account --output text)
  DEPLOY_BUCKET="nanoclaw-deploy-${ACCOUNT_ID}"
  TARBALL="/tmp/nanoclaw-deploy-$$.tar.gz"

  echo "Creating deployment archive from $PROJECT_ROOT..."
  tar czf "$TARBALL" \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='store' \
    --exclude='data' \
    --exclude='logs' \
    --exclude='groups' \
    --exclude='infra' \
    --exclude='*.tar.gz' \
    -C "$PROJECT_ROOT" .

  echo "Uploading to s3://$DEPLOY_BUCKET/deploy.tar.gz..."
  aws s3 mb "s3://$DEPLOY_BUCKET" $AWS_OPTS 2>/dev/null || true
  aws s3 cp "$TARBALL" "s3://$DEPLOY_BUCKET/deploy.tar.gz" $AWS_OPTS
  rm -f "$TARBALL"

  DEPLOY_COMMANDS=$(cat <<CMDS
    "set -euo pipefail",
    "cd /opt/nanoclaw",
    "aws s3 cp s3://$DEPLOY_BUCKET/deploy.tar.gz /tmp/nanoclaw-deploy.tar.gz --region $REGION",
    "rm -rf src/ dist/ setup/ container/ scripts/ .claude/",
    "tar xzf /tmp/nanoclaw-deploy.tar.gz --warning=no-unknown-keyword",
    "rm -f /tmp/nanoclaw-deploy.tar.gz",
    "chown -R ec2-user:ec2-user /opt/nanoclaw",
    "sudo -u ec2-user npm install --ignore-scripts",
    "sudo -u ec2-user npm run build",
    "sudo -u ec2-user npm prune --production --ignore-scripts",
    "sudo -u ec2-user npm rebuild better-sqlite3",
    "$CONTAINER_CMD",
    "sudo systemctl restart nanoclaw",
    "sleep 3",
    "systemctl is-active nanoclaw && echo Service is running || echo WARNING: Service failed to start"
CMDS
  )

  # Cleanup S3 on exit
  cleanup() {
    aws s3 rm "s3://$DEPLOY_BUCKET/deploy.tar.gz" $AWS_OPTS 2>/dev/null || true
  }
  trap cleanup EXIT
else
  DEPLOY_COMMANDS=$(cat <<CMDS
    "set -euo pipefail",
    "cd /opt/nanoclaw",
    "git pull",
    "npm install --ignore-scripts",
    "npm run build",
    "npm prune --production --ignore-scripts",
    "$CONTAINER_CMD",
    "sudo systemctl restart nanoclaw",
    "sleep 3",
    "systemctl is-active nanoclaw && echo Service is running || echo WARNING: Service failed to start"
CMDS
  )
fi

# --- Send SSM command ---
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds 600 \
  --parameters "{\"commands\":[$DEPLOY_COMMANDS]}" \
  $AWS_OPTS \
  --query 'Command.CommandId' \
  --output text)

echo "Command ID: $COMMAND_ID"
echo "Waiting for completion..."

# --- Poll for completion ---
for i in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    $AWS_OPTS \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")

  case "$STATUS" in
    Success)
      echo ""
      echo "=== Deploy succeeded ==="
      aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        $AWS_OPTS \
        --query 'StandardOutputContent' \
        --output text
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      echo ""
      echo "=== Deploy FAILED (status: $STATUS) ==="
      aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        $AWS_OPTS \
        --query '[StandardOutputContent, StandardErrorContent]' \
        --output text
      exit 1
      ;;
    *)
      printf "."
      sleep 5
      ;;
  esac
done

echo ""
echo "Timed out waiting for command. Check with:"
echo "  aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID $AWS_OPTS"
exit 1
