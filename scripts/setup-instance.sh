#!/usr/bin/env bash
# Interactive post-deploy setup for NanoClaw on AWS.
# Run after `cdk deploy` to configure the instance end-to-end.
#
# Usage:
#   ./scripts/setup-instance.sh [options]
#
# Options:
#   --region REGION      AWS region (default: $AWS_REGION or us-east-1)
#   --profile PROFILE    AWS CLI profile
#   --skip-secrets       Skip Secrets Manager configuration
#   --skip-whatsapp      Skip WhatsApp authentication
#   --skip-kiro          Skip kiro-cli authentication
#   --skip-register      Skip group registration
#   --instance-id ID     Use specific instance ID (skip discovery)

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${GREEN}=== $* ===${NC}\n"; }

# --- Parse arguments ---
REGION=""
PROFILE=""
SKIP_SECRETS=false
SKIP_WHATSAPP=false
SKIP_KIRO=false
SKIP_REGISTER=false
INSTANCE_ID=""
STACK_NAME="NanoClawStack"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)       REGION="$2"; shift 2 ;;
    --profile)      PROFILE="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=true; shift ;;
    --skip-whatsapp) SKIP_WHATSAPP=true; shift ;;
    --skip-kiro)    SKIP_KIRO=true; shift ;;
    --skip-register) SKIP_REGISTER=true; shift ;;
    --instance-id)  INSTANCE_ID="$2"; shift 2 ;;
    --stack)        STACK_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Interactive post-deploy setup for NanoClaw on AWS."
      echo "Run after 'cd infra && npx cdk deploy'."
      echo ""
      echo "Options:"
      echo "  --region REGION       AWS region (default: \$AWS_REGION or us-east-1)"
      echo "  --profile PROFILE     AWS CLI profile"
      echo "  --instance-id ID      Skip instance discovery, use this ID"
      echo "  --skip-secrets        Skip Secrets Manager step"
      echo "  --skip-whatsapp       Skip WhatsApp authentication"
      echo "  --skip-kiro           Skip kiro-cli authentication"
      echo "  --skip-register       Skip group registration"
      echo "  --stack NAME          CloudFormation stack name (default: NanoClawStack)"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

REGION="${REGION:-${AWS_REGION:-us-east-1}}"

# Build AWS CLI flags
AWS_OPTS="--region $REGION"
[[ -n "$PROFILE" ]] && AWS_OPTS="$AWS_OPTS --profile $PROFILE"

# --- Helper: get CloudFormation stack output ---
get_stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    $AWS_OPTS \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" \
    --output text 2>/dev/null
}

# --- Helper: run SSM command and return stdout ---
# Usage: result=$(run_ssm "command1" "command2" ...)
run_ssm() {
  local timeout="${SSM_TIMEOUT:-120}"
  local commands=""
  for cmd in "$@"; do
    [[ -n "$commands" ]] && commands="$commands,"
    commands="$commands\"$cmd\""
  done

  local cmd_id
  cmd_id=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --timeout-seconds "$timeout" \
    --parameters "{\"commands\":[$commands]}" \
    $AWS_OPTS \
    --query 'Command.CommandId' \
    --output text 2>/dev/null)

  if [[ -z "$cmd_id" || "$cmd_id" == "None" ]]; then
    error "Failed to send SSM command"
    return 1
  fi

  # Poll for result
  local max_polls=$(( timeout / 3 + 10 ))
  for i in $(seq 1 "$max_polls"); do
    local status
    status=$(aws ssm get-command-invocation \
      --command-id "$cmd_id" \
      --instance-id "$INSTANCE_ID" \
      $AWS_OPTS \
      --query 'Status' \
      --output text 2>/dev/null || echo "Pending")

    case "$status" in
      Success)
        aws ssm get-command-invocation \
          --command-id "$cmd_id" \
          --instance-id "$INSTANCE_ID" \
          $AWS_OPTS \
          --query 'StandardOutputContent' \
          --output text 2>/dev/null
        return 0
        ;;
      Failed|Cancelled|TimedOut)
        local stderr
        stderr=$(aws ssm get-command-invocation \
          --command-id "$cmd_id" \
          --instance-id "$INSTANCE_ID" \
          $AWS_OPTS \
          --query 'StandardErrorContent' \
          --output text 2>/dev/null || true)
        error "SSM command failed ($status): $stderr"
        return 1
        ;;
      *)
        sleep 3
        ;;
    esac
  done

  error "SSM command timed out after ${timeout}s"
  return 1
}

# ============================================================
# Step 0: Discover instance
# ============================================================
step "Step 0: Discover Instance"

if [[ -z "$INSTANCE_ID" ]]; then
  info "Looking up instance from CloudFormation stack '$STACK_NAME'..."

  ASG_NAME=$(get_stack_output "AsgName")
  if [[ -z "$ASG_NAME" || "$ASG_NAME" == "None" ]]; then
    error "Could not find ASG name from stack outputs. Is the stack deployed?"
    error "Run: cd infra && npx cdk deploy"
    exit 1
  fi

  INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$ASG_NAME" \
    $AWS_OPTS \
    --query 'AutoScalingGroups[0].Instances[0].InstanceId' \
    --output text 2>/dev/null)

  if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
    error "No running instance found in ASG '$ASG_NAME'."
    error "The instance may still be launching. Wait a minute and retry."
    exit 1
  fi
fi

success "Instance: $INSTANCE_ID"

# ============================================================
# Step 1: Wait for instance readiness
# ============================================================
step "Step 1: Wait for Instance Readiness"

info "Waiting for SSM agent to come online..."
for i in $(seq 1 60); do
  PING_STATUS=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    $AWS_OPTS \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text 2>/dev/null || echo "Unknown")

  if [[ "$PING_STATUS" == "Online" ]]; then
    break
  fi
  printf "."
  sleep 5
done
echo ""

if [[ "$PING_STATUS" != "Online" ]]; then
  error "SSM agent not online after 5 minutes. Check the instance."
  exit 1
fi

success "SSM agent is online"

info "Waiting for user-data to complete..."
for i in $(seq 1 60); do
  SERVICE_EXISTS=$(run_ssm "test -f /etc/systemd/system/nanoclaw.service && echo yes || echo no" 2>/dev/null || echo "no")
  SERVICE_EXISTS=$(echo "$SERVICE_EXISTS" | tr -d '[:space:]')
  if [[ "$SERVICE_EXISTS" == "yes" ]]; then
    break
  fi
  printf "."
  sleep 10
done
echo ""

if [[ "$SERVICE_EXISTS" != "yes" ]]; then
  warn "User-data may not have completed yet. Continuing anyway..."
  warn "Check /var/log/user-data.log on the instance if things fail."
else
  success "User-data setup complete"
fi

# ============================================================
# Step 2: Populate Secrets Manager
# ============================================================
if ! $SKIP_SECRETS; then
  step "Step 2: Configure Secrets"

  SECRET_ARN=$(get_stack_output "SecretArn")
  if [[ -z "$SECRET_ARN" || "$SECRET_ARN" == "None" ]]; then
    error "Could not find SecretArn from stack outputs."
    exit 1
  fi

  read -rp "Assistant name [Andy]: " ASSISTANT_NAME
  ASSISTANT_NAME="${ASSISTANT_NAME:-Andy}"

  read -rp "ANTHROPIC_API_KEY (leave blank if using kiro only): " ANTHROPIC_API_KEY
  read -rp "CLAUDE_CODE_OAUTH_TOKEN (leave blank if using kiro only): " CLAUDE_CODE_OAUTH_TOKEN

  # Build JSON — only include non-empty values
  SECRET_JSON="{\"ASSISTANT_NAME\":\"$ASSISTANT_NAME\""
  [[ -n "$ANTHROPIC_API_KEY" ]] && SECRET_JSON="$SECRET_JSON,\"ANTHROPIC_API_KEY\":\"$ANTHROPIC_API_KEY\""
  [[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]] && SECRET_JSON="$SECRET_JSON,\"CLAUDE_CODE_OAUTH_TOKEN\":\"$CLAUDE_CODE_OAUTH_TOKEN\""
  SECRET_JSON="$SECRET_JSON}"

  aws secretsmanager put-secret-value \
    --secret-id "$SECRET_ARN" \
    --secret-string "$SECRET_JSON" \
    $AWS_OPTS > /dev/null

  success "Secrets configured"
else
  info "Skipping secrets configuration (--skip-secrets)"
  ASSISTANT_NAME="Andy"
fi

# ============================================================
# Step 3: Deploy local code
# ============================================================
step "Step 3: Deploy Code"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

info "Deploying local code to instance..."
DEPLOY_ARGS="--local --region $REGION"
[[ -n "$PROFILE" ]] && DEPLOY_ARGS="$DEPLOY_ARGS --profile $PROFILE"

"$SCRIPT_DIR/deploy-aws.sh" $DEPLOY_ARGS "$INSTANCE_ID"

success "Code deployed and built"

# ============================================================
# Step 4: WhatsApp authentication
# ============================================================
if ! $SKIP_WHATSAPP; then
  step "Step 4: WhatsApp Authentication"

  # Check if already authenticated
  AUTH_CHECK=$(run_ssm "test -f /opt/nanoclaw/store/auth/creds.json && echo exists || echo missing" 2>/dev/null || echo "missing")
  AUTH_CHECK=$(echo "$AUTH_CHECK" | tr -d '[:space:]')

  if [[ "$AUTH_CHECK" == "exists" ]]; then
    success "WhatsApp already authenticated (store/auth/creds.json exists)"
  else
    read -rp "WhatsApp phone number (with country code, e.g. 14155551234): " PHONE_NUMBER

    if [[ -z "$PHONE_NUMBER" ]]; then
      error "Phone number required for WhatsApp authentication"
      exit 1
    fi

    info "Starting WhatsApp authentication (pairing code method)..."
    info "This takes about 10 seconds to generate the code..."

    # Run auth in background via SSM — it needs a long timeout for the full handshake
    SSM_TIMEOUT=150 AUTH_CMD_ID=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" \
      --document-name "AWS-RunShellScript" \
      --timeout-seconds 150 \
      --parameters "{\"commands\":[\"cd /opt/nanoclaw && sudo -u ec2-user npx tsx src/whatsapp-auth.ts --pairing-code --phone $PHONE_NUMBER\"]}" \
      $AWS_OPTS \
      --query 'Command.CommandId' \
      --output text)

    # Poll for pairing code in output
    PAIRING_CODE=""
    for i in $(seq 1 30); do
      OUTPUT=$(aws ssm get-command-invocation \
        --command-id "$AUTH_CMD_ID" \
        --instance-id "$INSTANCE_ID" \
        $AWS_OPTS \
        --query 'StandardOutputContent' \
        --output text 2>/dev/null || echo "")

      # Match: "pairing code: XXXX-XXXX" from src/whatsapp-auth.ts:87
      PAIRING_CODE=$(echo "$OUTPUT" | grep -o 'pairing code: [A-Z0-9-]*' | head -1 | sed 's/pairing code: //' || true)
      if [[ -n "$PAIRING_CODE" ]]; then
        break
      fi

      # Check if command already failed
      CMD_STATUS=$(aws ssm get-command-invocation \
        --command-id "$AUTH_CMD_ID" \
        --instance-id "$INSTANCE_ID" \
        $AWS_OPTS \
        --query 'Status' \
        --output text 2>/dev/null || echo "InProgress")
      if [[ "$CMD_STATUS" == "Failed" ]]; then
        STDERR=$(aws ssm get-command-invocation \
          --command-id "$AUTH_CMD_ID" \
          --instance-id "$INSTANCE_ID" \
          $AWS_OPTS \
          --query 'StandardErrorContent' \
          --output text 2>/dev/null || true)
        error "WhatsApp auth failed: $STDERR"
        exit 1
      fi

      sleep 2
    done

    if [[ -z "$PAIRING_CODE" ]]; then
      error "Could not get pairing code within 60 seconds."
      error "Check logs on instance: journalctl -u nanoclaw"
      exit 1
    fi

    echo ""
    echo -e "  ${GREEN}Your pairing code: ${YELLOW}${PAIRING_CODE}${NC}"
    echo ""
    echo "  1. Open WhatsApp on your phone"
    echo "  2. Settings -> Linked Devices -> Link a Device"
    echo "  3. Tap 'Link with phone number instead'"
    echo -e "  4. Enter this code: ${YELLOW}${PAIRING_CODE}${NC}"
    echo ""
    echo "  Enter the code NOW -- it expires in about 60 seconds."
    echo ""
    read -rp "Press Enter after you've entered the pairing code..."

    # Wait for auth to complete
    info "Waiting for WhatsApp to confirm authentication..."
    for i in $(seq 1 30); do
      CMD_STATUS=$(aws ssm get-command-invocation \
        --command-id "$AUTH_CMD_ID" \
        --instance-id "$INSTANCE_ID" \
        $AWS_OPTS \
        --query 'Status' \
        --output text 2>/dev/null || echo "InProgress")

      if [[ "$CMD_STATUS" == "Success" ]]; then
        break
      elif [[ "$CMD_STATUS" == "Failed" ]]; then
        warn "Auth command returned failure -- checking if auth actually succeeded..."
        break
      fi
      sleep 2
    done

    # Verify credentials were saved
    CREDS_CHECK=$(run_ssm "test -f /opt/nanoclaw/store/auth/creds.json && echo exists || echo missing" 2>/dev/null || echo "missing")
    CREDS_CHECK=$(echo "$CREDS_CHECK" | tr -d '[:space:]')

    if [[ "$CREDS_CHECK" == "exists" ]]; then
      success "WhatsApp authenticated successfully!"
    else
      error "WhatsApp authentication may not have completed."
      error "You can retry with: $0 --skip-secrets --skip-kiro --skip-register"
      exit 1
    fi
  fi
else
  info "Skipping WhatsApp authentication (--skip-whatsapp)"
fi

# ============================================================
# Step 5: Register main group
# ============================================================
if ! $SKIP_REGISTER; then
  step "Step 5: Register Main Group"

  # Check if already registered
  REG_CHECK=$(run_ssm "cd /opt/nanoclaw && node -e \"const db=require(require('path').join(process.cwd(),'node_modules','better-sqlite3'))('store/messages.db');try{const r=db.prepare('SELECT folder FROM registered_groups WHERE is_main=1').get();console.log(r?'registered':'none')}catch(e){console.log('none')}\"" 2>/dev/null || echo "none")
  REG_CHECK=$(echo "$REG_CHECK" | tr -d '[:space:]')

  if [[ "$REG_CHECK" == "registered" ]]; then
    success "Main group already registered"
  else
    # Get JID from WhatsApp credentials
    SELF_JID=$(run_ssm "cd /opt/nanoclaw && node -e \"const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me.id.split(':')[0]+'@s.whatsapp.net')\"" 2>/dev/null || echo "")
    SELF_JID=$(echo "$SELF_JID" | tr -d '[:space:]')

    if [[ -z "$SELF_JID" || "$SELF_JID" == "undefined@s.whatsapp.net" ]]; then
      error "Could not extract WhatsApp JID from credentials."
      error "Run WhatsApp auth first (remove --skip-whatsapp)."
      exit 1
    fi

    info "Self JID: $SELF_JID"
    info "Registering main group (whatsapp_main) with kiro provider..."

    # Register via setup CLI
    run_ssm \
      "cd /opt/nanoclaw && sudo -u ec2-user npx tsx setup/index.ts --step register --jid $SELF_JID --name main --trigger @${ASSISTANT_NAME:-Andy} --folder whatsapp_main --channel whatsapp --assistant-name ${ASSISTANT_NAME:-Andy} --is-main --no-trigger-required" \
      > /dev/null 2>&1

    # Update container_config to use kiro provider
    # Upload a small script via the deploy bucket to avoid quoting issues
    ACCOUNT_ID=$(aws sts get-caller-identity $AWS_OPTS --query Account --output text)
    DEPLOY_BUCKET="nanoclaw-deploy-${ACCOUNT_ID}"

    cat > /tmp/set-kiro-provider.js << 'NODESCRIPT'
const path = require('path');
const db = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'))('store/messages.db');
db.prepare("UPDATE registered_groups SET container_config = ? WHERE folder = ?").run(
  JSON.stringify({provider:"kiro",providerMode:"host"}),
  "whatsapp_main"
);
const r = db.prepare("SELECT jid, folder, container_config FROM registered_groups WHERE is_main = 1").get();
console.log(JSON.stringify(r));
NODESCRIPT

    aws s3 mb "s3://$DEPLOY_BUCKET" $AWS_OPTS 2>/dev/null || true
    aws s3 cp /tmp/set-kiro-provider.js "s3://$DEPLOY_BUCKET/set-kiro-provider.js" $AWS_OPTS > /dev/null
    rm -f /tmp/set-kiro-provider.js

    PROVIDER_RESULT=$(run_ssm \
      "aws s3 cp s3://$DEPLOY_BUCKET/set-kiro-provider.js /tmp/set-kiro-provider.js --region $REGION" \
      "cd /opt/nanoclaw && sudo -u ec2-user node /tmp/set-kiro-provider.js" \
      2>/dev/null || echo "")

    aws s3 rm "s3://$DEPLOY_BUCKET/set-kiro-provider.js" $AWS_OPTS 2>/dev/null || true

    info "Registration result: $PROVIDER_RESULT"
    success "Main group registered with kiro provider"
  fi
else
  info "Skipping group registration (--skip-register)"
fi

# ============================================================
# Step 6: Kiro-cli authentication
# ============================================================
if ! $SKIP_KIRO; then
  step "Step 6: Kiro CLI Authentication"

  # Check if kiro is already authenticated
  KIRO_CHECK=$(run_ssm "sudo -u ec2-user /home/ec2-user/.local/bin/kiro-cli whoami 2>/dev/null && echo authed || echo not_authed" 2>/dev/null || echo "not_authed")

  if echo "$KIRO_CHECK" | grep -q "authed"; then
    success "Kiro CLI already authenticated"
  else
    echo ""
    echo "  Kiro CLI requires interactive browser-based authentication."
    echo "  Please open a NEW terminal and run:"
    echo ""
    echo -e "    ${YELLOW}aws ssm start-session --target $INSTANCE_ID $AWS_OPTS${NC}"
    echo ""
    echo "  Then in the session, run:"
    echo ""
    echo -e "    ${YELLOW}sudo -u ec2-user /home/ec2-user/.local/bin/kiro-cli login${NC}"
    echo ""
    echo "  Follow the device code instructions to authenticate in your browser."
    echo ""
    read -rp "Press Enter after you've completed kiro-cli authentication..."

    success "Kiro CLI authentication step complete"
  fi
else
  info "Skipping kiro-cli authentication (--skip-kiro)"
fi

# ============================================================
# Step 7: Start service and verify
# ============================================================
step "Step 7: Start Service"

info "Restarting NanoClaw service..."
run_ssm "sudo systemctl restart nanoclaw" > /dev/null 2>&1 || true

info "Waiting for service to initialize..."
sleep 5

SERVICE_STATUS=$(run_ssm "systemctl is-active nanoclaw" 2>/dev/null || echo "unknown")
SERVICE_STATUS=$(echo "$SERVICE_STATUS" | tr -d '[:space:]')

if [[ "$SERVICE_STATUS" == "active" ]]; then
  # Check for successful startup in logs
  LOGS=$(run_ssm "journalctl -u nanoclaw --since '30 seconds ago' --no-pager -n 5 | grep -o 'NanoClaw running.*' || echo ''" 2>/dev/null || echo "")

  success "NanoClaw service is running!"
  [[ -n "$LOGS" ]] && info "$LOGS"
else
  warn "Service status: $SERVICE_STATUS"
  warn "Check logs with: aws ssm start-session --target $INSTANCE_ID $AWS_OPTS"
  warn "Then: journalctl -u nanoclaw --no-pager -n 50"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  NanoClaw Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Instance:  $INSTANCE_ID"
echo "  Region:    $REGION"
echo "  Provider:  kiro (host mode)"
echo ""
echo "  Send a message to your WhatsApp self-chat to test."
echo ""
echo "  Useful commands:"
echo "    SSM session:  aws ssm start-session --target $INSTANCE_ID $AWS_OPTS"
echo "    View logs:    journalctl -u nanoclaw -f"
echo "    Restart:      sudo systemctl restart nanoclaw"
echo "    Deploy code:  ./scripts/deploy-aws.sh --local $INSTANCE_ID"
echo ""
