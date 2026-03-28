# AWS Deployment

Deploy NanoClaw on a single EC2 spot instance (~$10/month). Zero inbound ports, all management via SSM.

## Quick Start

```bash
# 1. Deploy infrastructure
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy
cd ..

# 2. Set up the instance (interactive — secrets, WhatsApp, kiro, service)
./scripts/setup-instance.sh --region ca-central-1 --profile YOUR_PROFILE

# Done. Send a message to your WhatsApp self-chat.
```

## What the Scripts Do

### `scripts/setup-instance.sh`

Interactive post-deploy script. Runs locally after `cdk deploy`. Steps:

1. **Discover instance** — finds EC2 instance from CloudFormation stack outputs
2. **Wait for readiness** — polls until SSM agent is online and user-data completes
3. **Configure secrets** — prompts for assistant name, optional API keys, writes to Secrets Manager
4. **Deploy code** — tars local code, uploads via S3, extracts on instance, builds
5. **WhatsApp auth** — runs pairing code flow, displays code for you to enter on phone
6. **Register main group** — registers self-chat with kiro provider
7. **Kiro-cli auth** — guides you through device code auth via SSM session
8. **Start service** — restarts systemd service, verifies it's running

Each step can be skipped: `--skip-secrets`, `--skip-whatsapp`, `--skip-kiro`, `--skip-register`.

### `scripts/deploy-aws.sh`

Push code updates without redeploying infrastructure.

```bash
# Git pull mode (changes pushed to GitHub)
./scripts/deploy-aws.sh INSTANCE_ID

# Local mode (unpushed changes, via tar+S3)
./scripts/deploy-aws.sh --local INSTANCE_ID

# With profile/region
./scripts/deploy-aws.sh --local --region ca-central-1 --profile AYBconsole INSTANCE_ID
```

## Infrastructure

Created by `cd infra && npx cdk deploy`:

| Resource | Details |
|----------|---------|
| EC2 instance | `t4g.small` ARM Graviton, spot (~$5/mo) |
| Root volume | 20GB gp3 (ephemeral, recreated on spot replacement) |
| Data volume | 20GB gp3 (persistent, survives spot replacement) |
| Secrets | Secrets Manager `nanoclaw/secrets` |
| Logs | CloudWatch `/nanoclaw/application` (30-day retention) |
| Backups | Daily EBS snapshots, 7-day retention |
| Security | Zero inbound, outbound HTTPS/DNS/HTTP only |
| Management | SSM Session Manager (no SSH) |

## Manual Operations

### Connect to instance

```bash
# Find instance ID
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names $(aws cloudformation describe-stacks \
    --stack-name NanoClawStack --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" --output text) \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

# Connect
aws ssm start-session --target $INSTANCE_ID
```

### View logs

```bash
journalctl -u nanoclaw -f          # live logs
journalctl -u nanoclaw --since "1 hour ago"  # recent
```

### Restart service

```bash
sudo systemctl restart nanoclaw
```

### Re-authenticate kiro-cli

Token expired? Connect via SSM and:

```bash
sudo -u ec2-user /home/ec2-user/.local/bin/kiro-cli login
```

### Re-authenticate WhatsApp

```bash
./scripts/setup-instance.sh --skip-secrets --skip-kiro --skip-register
```

### Update secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/secrets \
  --secret-string '{"ASSISTANT_NAME":"Andy","ANTHROPIC_API_KEY":"sk-ant-..."}'
```

## Troubleshooting

### Service won't start

```bash
# Check user-data log (first boot)
cat /var/log/user-data.log

# Check service logs
journalctl -u nanoclaw --no-pager -n 50

# Common: "Region is missing" → AWS_REGION not set in systemd service
# Fix: Already handled in CDK stack. If missing, add manually:
#   sudo sed -i '/LOG_LEVEL/a Environment=AWS_REGION=YOUR_REGION' /etc/systemd/system/nanoclaw.service
#   sudo systemctl daemon-reload && sudo systemctl restart nanoclaw
```

### WhatsApp pairing code expired

Codes expire in ~60 seconds. Re-run setup with just WhatsApp:

```bash
./scripts/setup-instance.sh --skip-secrets --skip-kiro --skip-register
```

### Instance replaced by spot interruption

Data persists on the EBS volume. The new instance auto-attaches the volume and starts the service. You may need to re-authenticate WhatsApp (linked device sessions can expire).

### npm install fails

The user data uses `--ignore-scripts` to skip the husky prepare hook. If you see prepare/husky errors, make sure the deploy script also uses `--ignore-scripts`.

## Cost Breakdown

| Component | Monthly |
|-----------|---------|
| EC2 spot (t4g.small) | ~$5 |
| EBS data volume (20GB gp3) | ~$1.60 |
| EBS root volume (20GB gp3) | ~$1.60 |
| EBS snapshots (7-day) | ~$0.50 |
| Secrets Manager | ~$0.40 |
| CloudWatch Logs | ~$0.50 |
| **Total** | **~$10** |
