# NanoClaw AWS Infrastructure

CDK stack for deploying NanoClaw to AWS. Single EC2 spot instance (~$10/month), zero inbound ports, managed via SSM.

See [docs/AWS-DEPLOYMENT.md](../docs/AWS-DEPLOYMENT.md) for full deployment guide and operational runbook.

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
│    ├─ store/  (DB, WA auth)     │
│    ├─ groups/ (per-group data)  │
│    ├─ logs/                     │
│    ├─ data/                     │
│    └─ .kiro-cli-auth/           │
└─────────────────────────────────┘
    │
    ▼
Secrets Manager (nanoclaw/secrets)
CloudWatch Logs (/nanoclaw/application)
AWS Backup (daily EBS snapshots)
```

## Deploy

```bash
npm install
npx cdk bootstrap   # first time only
AWS_PROFILE=AYBconsole npx cdk deploy
```

## What It Creates

| Resource | Details |
|----------|---------|
| EC2 instance | `t4g.small` ARM Graviton, spot (~$5/mo) |
| Root volume | 20GB gp3, encrypted (ephemeral) |
| Data volume | 20GB gp3, encrypted, RETAIN (persistent) |
| Secrets | Secrets Manager `nanoclaw/secrets` |
| Logs | CloudWatch `/nanoclaw/application` (30-day retention) |
| Backups | Daily EBS snapshots, 7-day retention |
| Security | Zero inbound, outbound HTTPS/DNS/HTTP only |
| Management | SSM Session Manager (no SSH) |

## User-Data Bootstrap

The launch template user-data handles full instance provisioning:

1. Install system packages (Docker, Node.js 20, git)
2. Create 1GB swap file
3. Attach persistent EBS data volume at `/opt/nanoclaw-data`
4. Clone code from `qvdm/multi-nano-claw`
5. Symlink persistent dirs (`store/`, `data/`, `groups/`, `logs/`) to EBS
6. Build: `npm install --ignore-scripts` → `npm run build` → `npm prune --production --ignore-scripts` → `npm rebuild better-sqlite3`
7. Install kiro-cli, symlink auth to EBS
8. Install and start systemd service

## Systemd Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `NANOCLAW_SECRETS_ARN` | Secret ARN | Load secrets from Secrets Manager |
| `MAX_CONCURRENT_CONTAINERS` | `1` | Fits within 2GB RAM |
| `LOG_LEVEL` | `info` | Application log verbosity |
| `AWS_REGION` | `ca-central-1` | AWS SDK region resolution |
| `KIRO_CLI_PATH` | `/home/ec2-user/.local/bin/kiro-cli` | kiro-cli binary location |

## Tear Down

```bash
AWS_PROFILE=AYBconsole npx cdk destroy
```

The data EBS volume has `RemovalPolicy.RETAIN` and will **not** be deleted. Remove it manually in the AWS console if desired.
