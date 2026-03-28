# AWS Deployment

Deploy NanoClaw on a single EC2 spot instance (~$10/month). Zero inbound ports, all management via SSM.

## Current State (March 2026)

**Instance is stopped** (ASG scaled to 0). Persistent EBS data volume retains WhatsApp auth, SQLite DB, and group memory.

### Before Restarting

The following must be fixed for unattended spot replacement to work:

1. **User-data clones wrong repo** — currently clones `qwibitai/NanoClaw` (upstream), needs to clone the fork with kiro support
2. **Build pipeline broken** — `npm install --production` omits typescript; needs full install → build → prune
3. **kiro-cli auth not persisted** — auth tokens on root volume are lost on spot replacement; need to symlink to EBS
4. **CDK stack outdated on AWS** — local fixes (S3 IAM policy, build fix) haven't been deployed via `cdk deploy`

### Planned Improvements

- Use public GitHub repo (fork) as code source in user-data
- GitHub Actions for automated deployment on push
- Persist kiro-cli auth tokens on EBS data volume
- SNS notification when interactive re-auth is needed

## Quick Start

```bash
# 1. Deploy infrastructure
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy --profile AYBconsole
cd ..

# 2. Set up the instance (interactive — secrets, WhatsApp, kiro, service)
./scripts/setup-instance.sh --region ca-central-1 --profile AYBconsole

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
./scripts/deploy-aws.sh --region ca-central-1 --profile AYBconsole INSTANCE_ID

# Local mode (unpushed changes, via tar+S3)
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

## Spot Replacement Behavior

### Automatic (handled by user-data)
- System packages installed (Docker, Node.js 20, git)
- Swap file created
- EBS data volume attached and mounted
- Code cloned from GitHub
- Symlinks created (store/, data/, groups/, logs/ → EBS)
- npm install + build
- kiro-cli installed
- Systemd service installed and started

### Requires Manual Intervention
- **kiro-cli auth** — `kiro-cli login` via SSM session (device code flow)
- **WhatsApp re-auth** — if linked device session expired (~30 days), run setup-instance.sh with `--skip-secrets --skip-kiro --skip-register`

## Start/Stop Instance

```bash
# Get ASG name
ASG_NAME=$(aws cloudformation describe-stacks \
  --stack-name NanoClawStack \
  --region ca-central-1 --profile AYBconsole \
  --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" --output text)

# Stop
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name $ASG_NAME \
  --min-size 0 --desired-capacity 0 \
  --region ca-central-1 --profile AYBconsole

# Start
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name $ASG_NAME \
  --min-size 1 --desired-capacity 1 \
  --region ca-central-1 --profile AYBconsole
```

## Manual Operations

### Connect to instance

```bash
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names $ASG_NAME \
  --region ca-central-1 --profile AYBconsole \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

aws ssm start-session --target $INSTANCE_ID --region ca-central-1 --profile AYBconsole
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
  --secret-string '{"ASSISTANT_NAME":"Andy","ANTHROPIC_API_KEY":"sk-ant-..."}' \
  --region ca-central-1 --profile AYBconsole
```

## Troubleshooting

### Service won't start

```bash
# Check user-data log (first boot)
cat /var/log/user-data.log

# Check service logs
journalctl -u nanoclaw --no-pager -n 50
```

### npm install/build fails

Common causes:
- `npm install --production` omits typescript → `tsc: command not found`. Fix: use full install, build, then prune.
- husky prepare script fails without devDeps → use `--ignore-scripts`
- Stale upstream files after tar deploy → clean `src/` and `dist/` before extracting

### WhatsApp pairing code expired

Codes expire in ~60 seconds. Re-run setup with just WhatsApp:

```bash
./scripts/setup-instance.sh --skip-secrets --skip-kiro --skip-register
```

### Instance replaced by spot interruption

Data persists on the EBS volume. The new instance auto-attaches the volume and starts the service. You may need to:
1. Re-authenticate kiro-cli (`kiro-cli login` via SSM)
2. Re-authenticate WhatsApp if linked device session expired

### SSO token expired

```bash
aws sso login --profile AYBconsole
```

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
