# NanoClaw AWS Infrastructure

CDK stack for deploying NanoClaw to AWS. Single EC2 spot instance (~$10/month), zero inbound ports, managed via SSM.

## Current Status

**Paused.** ASG should be scaled to 0 (no running instance). The persistent EBS data volume retains WhatsApp auth, SQLite DB, group registrations, and per-group memory.

### What Works
- CDK stack deploys correctly (VPC, SG, ASG, EBS, Secrets Manager, CloudWatch, Backup)
- Persistent EBS data volume survives spot replacements
- Systemd service template has correct env vars (AWS_REGION, KIRO_CLI_PATH, etc.)
- deploy-aws.sh --local can push code via tar+S3

### What Doesn't Work (Yet)
- **User-data clones wrong repo** — clones upstream `qwibitai/NanoClaw`, not our fork with kiro support
- **User-data can't build** — uses `npm install --production` which omits typescript (devDep), so `tsc` fails
- **Spot replacement requires manual intervention** — kiro-cli auth and WhatsApp re-auth can't be automated
- **No CI/CD** — code deploys are manual via deploy-aws.sh
- **CDK stack not redeployed** — local fixes to nanoclaw-stack.ts (S3 IAM policy, etc.) haven't been pushed to AWS

## What It Creates

| Resource | Details |
|----------|---------|
| EC2 instance | `t4g.small` ARM Graviton, spot (~$5/mo) |
| Root volume | 20GB gp3, encrypted (ephemeral — destroyed on spot replacement) |
| Data volume | 20GB gp3, encrypted (persistent across spot replacements) |
| Secrets | Secrets Manager `nanoclaw/secrets` |
| Logs | CloudWatch `/nanoclaw/application` (30-day retention) |
| Backups | Daily EBS snapshots, 7-day retention |
| Security | Zero inbound, outbound HTTPS/DNS/HTTP only |
| Management | SSM Session Manager (no SSH needed) |

## Architecture

```
Internet
    │
    ▼ (outbound only)
┌─────────────────────────────────┐
│  EC2 Spot Instance (t4g.small)  │
│  Amazon Linux 2023 ARM64        │
│                                 │
│  systemd: nanoclaw.service      │
│    └─ node dist/index.js        │
│        ├─ WhatsApp (Baileys)    │
│        ├─ kiro-cli (host mode)  │
│        └─ SQLite (on EBS)       │
│                                 │
│  /opt/nanoclaw      (code)      │
│  /opt/nanoclaw-data (EBS vol)   │
│    ├─ store/  (SQLite DB, auth) │
│    ├─ groups/ (per-group data)  │
│    ├─ logs/                     │
│    └─ data/                     │
└─────────────────────────────────┘
    │
    ▼
Secrets Manager (nanoclaw/secrets)
CloudWatch Logs (/nanoclaw/application)
AWS Backup (daily EBS snapshots)
```

## Spot Replacement: What Survives vs What's Lost

### Survives (on persistent EBS data volume)
- `store/` — SQLite DB, WhatsApp auth credentials, auth state
- `groups/` — per-group CLAUDE.md memory files
- `data/` — container env files
- `logs/` — application logs

### Lost (on ephemeral root volume)
- kiro-cli binary and auth tokens (`~/.local/share/kiro-cli/`)
- Docker images/layers
- Installed npm packages (rebuilt by user-data)
- Any manual edits to systemd service or OS config

### Requires Manual Re-auth After Spot Replacement
- **kiro-cli**: `kiro-cli login` — requires interactive device code flow (browser approval)
- **WhatsApp**: May need re-pairing if linked device session expires (~30 days)

## TODO: Resilient Spot Restarts

The user-data script must be fully self-sufficient so a fresh instance works without intervention:

1. **Clone from correct repo** — change `qwibitai/NanoClaw` to the public fork with kiro support
2. **Fix build pipeline** — `npm install` (full) → `npm run build` → `npm prune --production`
3. **Persist kiro-cli auth** — symlink `~/.local/share/kiro-cli/` to EBS data volume
4. **GitHub Actions CI/CD** — push to main triggers deploy to instance via SSM
5. **Auth failure notification** — if kiro/WhatsApp auth is missing, send SNS notification instead of silently failing
6. **Redeploy CDK stack** — push local fixes (S3 IAM policy, build pipeline) to AWS

## Quick Start

### Prerequisites

- AWS CLI configured with SSO (`aws sso login --profile AYBconsole`)
- Node.js 20+
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

### Deploy Infrastructure

```bash
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy --profile AYBconsole
```

### Start/Stop Instance

```bash
# Start (scale ASG to 1)
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name ASG_NAME \
  --min-size 1 --desired-capacity 1 \
  --region ca-central-1 --profile AYBconsole

# Stop (scale ASG to 0)
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name ASG_NAME \
  --min-size 0 --desired-capacity 0 \
  --region ca-central-1 --profile AYBconsole
```

### Set Up the Instance (after first deploy or spot replacement)

```bash
cd ..
./scripts/setup-instance.sh --region ca-central-1 --profile AYBconsole
```

### Deploy Code Updates

```bash
# From local code (unpushed changes)
./scripts/deploy-aws.sh --local --region ca-central-1 --profile AYBconsole INSTANCE_ID

# From GitHub (after pushing)
./scripts/deploy-aws.sh --region ca-central-1 --profile AYBconsole INSTANCE_ID
```

## Systemd Service Environment

| Variable | Value | Purpose |
|----------|-------|---------|
| `NANOCLAW_SECRETS_ARN` | Secret ARN | Load secrets from Secrets Manager |
| `MAX_CONCURRENT_CONTAINERS` | `1` | Fits within 2GB RAM |
| `LOG_LEVEL` | `info` | Application log verbosity |
| `AWS_REGION` | `ca-central-1` | AWS SDK region resolution (required!) |
| `KIRO_CLI_PATH` | `/home/ec2-user/.local/bin/kiro-cli` | kiro-cli binary location |

## Common Operations

### Connect to instance

```bash
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names $(aws cloudformation describe-stacks \
    --stack-name NanoClawStack \
    --region ca-central-1 --profile AYBconsole \
    --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" \
    --output text) \
  --region ca-central-1 --profile AYBconsole \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

aws ssm start-session --target $INSTANCE_ID --region ca-central-1 --profile AYBconsole
```

### View logs

```bash
journalctl -u nanoclaw -f
```

### Re-authenticate kiro-cli

```bash
sudo -u ec2-user /home/ec2-user/.local/bin/kiro-cli login
```

### Tear down

```bash
npx cdk destroy --profile AYBconsole
```

Note: The data EBS volume has `RemovalPolicy.RETAIN` and will **not** be deleted. Delete it manually in the AWS console if desired.

## Lessons Learned

1. **`npm install --production` breaks build** — typescript is a devDependency; must do full install, build, then prune
2. **Systemd services don't inherit env vars** — must explicitly set AWS_REGION, KIRO_CLI_PATH in unit file
3. **kiro-cli auth is `kiro-cli login`** — not `kiro-cli auth login`
4. **Tar overlay deploys leave stale files** — must `rm -rf src/ dist/` before extracting to avoid old upstream files causing build errors
5. **SSO tokens expire frequently** — re-run `aws sso login --profile AYBconsole` when you see token errors
6. **S3 deploy bucket IAM** — instance role needs s3:GetObject on `nanoclaw-deploy-ACCOUNT/*`

## Cost

~$10/month total: EC2 spot ~$5, EBS volumes ~$3.20, backups ~$0.50, Secrets Manager ~$0.40, CloudWatch ~$0.50.
