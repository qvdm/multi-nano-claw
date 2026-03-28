#!/usr/bin/env bash
# Authenticate kiro-cli on the remote EC2 instance.
# Opens an interactive SSM session and runs the device-flow login.
#
# Usage: ./scripts/kiro-auth.sh [instance-id]
#
# Options:
#   --region REGION      AWS region (default: $AWS_REGION or ca-central-1)
#   --profile PROFILE    AWS CLI profile

set -euo pipefail

REGION=""
PROFILE=""
INSTANCE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)  REGION="$2";  shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--region REGION] [--profile PROFILE] [instance-id]"
      exit 0
      ;;
    *) INSTANCE_ID="$1"; shift ;;
  esac
done

REGION="${REGION:-${AWS_REGION:-ca-central-1}}"
AWS_OPTS="--region $REGION"
[[ -n "$PROFILE" ]] && AWS_OPTS="$AWS_OPTS --profile $PROFILE"

# Auto-discover instance from ASG if not provided
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="${NANOCLAW_INSTANCE_ID:-}"
fi

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Discovering instance from ASG..."
  ASG_NAME=$(aws cloudformation describe-stacks \
    --stack-name NanoClawStack \
    $AWS_OPTS \
    --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" \
    --output text 2>/dev/null) || true

  if [[ -n "$ASG_NAME" ]]; then
    INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
      --auto-scaling-group-names "$ASG_NAME" \
      $AWS_OPTS \
      --query 'AutoScalingGroups[0].Instances[0].InstanceId' \
      --output text 2>/dev/null) || true
  fi
fi

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "Error: Could not find instance. Pass instance-id as argument or set NANOCLAW_INSTANCE_ID."
  exit 1
fi

echo "Instance: $INSTANCE_ID"
echo ""
echo "Starting SSM session. Once connected, run:"
echo ""
echo "  /opt/nanoclaw/scripts/kiro-auth-remote.sh"
echo ""
echo "Follow the instructions to complete device-flow authentication."
echo "Press Ctrl+D or type 'exit' when done."
echo ""

# shellcheck disable=SC2086
aws ssm start-session --target "$INSTANCE_ID" $AWS_OPTS
