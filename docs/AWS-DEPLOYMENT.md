# AWS Deployment

Deploy NanoClaw on a single EC2 spot instance (~$10/month). Zero inbound ports, all management via SSM.

## Quick Start

```bash
# 1. Deploy infrastructure
cd infra
npm install
npx cdk bootstrap   # first time only
AWS_PROFILE=AYBconsole npx cdk deploy
cd ..

# 2. Deploy code to instance
./scripts/deploy-aws.sh --local --skip-container --profile AYBconsole

# 3. Authenticate kiro-cli
./scripts/kiro-auth.sh --profile AYBconsole
# In the SSM session, run: /opt/nanoclaw/scripts/kiro-auth-remote.sh

# Done. Send a message to your WhatsApp self-chat.
```

## Prerequisites

- AWS CLI configured with SSO (`aws sso login --profile AYBconsole`)
- Node.js 20+
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## Scripts

### `scripts/deploy-aws.sh`

Push code updates to the running instance.

```bash
# Deploy local code (unpushed changes, via tar+S3)
./scripts/deploy-aws.sh --local --skip-container --profile AYBconsole [instance-id]

# Deploy from GitHub (after pushing to qvdm/multi-nano-claw)
./scripts/deploy-aws.sh --skip-container --profile AYBconsole [instance-id]
```

Options:
- `--local` — tar local working directory instead of `git pull`
- `--skip-container` — skip Docker container build (use for kiro host mode)
- `--region REGION` — AWS region (default: ca-central-1)
- `--profile PROFILE` — AWS CLI profile

Instance ID is auto-discovered from the ASG if omitted (set `NANOCLAW_INSTANCE_ID` env var as alternative).

### `scripts/kiro-auth.sh`

Authenticate kiro-cli on the remote instance via interactive SSM session.

```bash
./scripts/kiro-auth.sh --profile AYBconsole [instance-id]
```

Auto-discovers the instance from the ASG, opens an SSM session, and tells you to run the remote script. Once connected:

```bash
/opt/nanoclaw/scripts/kiro-auth-remote.sh
```

The remote script:
1. Installs kiro-cli if missing
2. Ensures auth is symlinked to persistent EBS volume
3. Runs `kiro-cli login --device-flow` (prints URL + code for browser approval)
4. Restarts the NanoClaw service after auth succeeds

### `scripts/setup-instance.sh`

Interactive post-deploy script for first-time setup (secrets, WhatsApp auth, group registration). Steps can be skipped with `--skip-secrets`, `--skip-whatsapp`, `--skip-kiro`, `--skip-register`.

## Infrastructure

Created by `cd infra && AWS_PROFILE=AYBconsole npx cdk deploy`:

| Resource | Details |
|----------|---------|
| EC2 instance | `t4g.small` ARM Graviton, spot (~$5/mo) |
| Root volume | 20GB gp3, encrypted (ephemeral) |
| Data volume | 20GB gp3, encrypted, RETAIN policy (persistent) |
| Secrets | Secrets Manager `nanoclaw/secrets` |
| Logs | CloudWatch `/nanoclaw/application` (30-day retention) |
| Backups | Daily EBS snapshots, 7-day retention |
| Security | Zero inbound, outbound HTTPS/DNS/HTTP only |
| Management | SSM Session Manager (no SSH) |

## Spot Replacement Behavior

When AWS reclaims the spot instance and launches a replacement:

### Automatic (user-data handles these)
- System packages (Docker, Node.js 20, git)
- Swap file (1GB)
- EBS data volume attached and mounted at `/opt/nanoclaw-data`
- Code cloned from `qvdm/multi-nano-claw`
- Symlinks: `store/`, `data/`, `groups/`, `logs/` → EBS data volume
- Full build: `npm install` → `npm run build` → `npm prune --production` → `npm rebuild better-sqlite3`
- kiro-cli installed, auth symlinked to EBS
- Systemd service installed and started

### Requires Manual Intervention
- **kiro-cli auth** — run `./scripts/kiro-auth.sh --profile AYBconsole` (device-flow needs browser approval). Auth tokens persist on EBS, so this is only needed if tokens expire or EBS is wiped.
- **WhatsApp re-auth** — only if linked device session expired (~30 days). Run `./scripts/setup-instance.sh --skip-secrets --skip-kiro --skip-register`.

### What Persists on EBS (`/opt/nanoclaw-data`)
- `store/` — SQLite DB, WhatsApp auth credentials
- `groups/` — per-group CLAUDE.md memory
- `data/` — container env files
- `logs/` — application logs
- `.kiro-cli-auth/` — kiro-cli auth tokens (symlinked from `~/.local/share/kiro-cli`)

## Start / Stop Instance

```bash
ASG_NAME=$(aws cloudformation describe-stacks \
  --stack-name NanoClawStack \
  --region ca-central-1 --profile AYBconsole \
  --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" --output text)

# Stop (scale to 0)
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name $ASG_NAME \
  --min-size 0 --desired-capacity 0 \
  --region ca-central-1 --profile AYBconsole

# Start (scale to 1)
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name $ASG_NAME \
  --min-size 1 --desired-capacity 1 \
  --region ca-central-1 --profile AYBconsole
```

## Manual Operations

### Connect to instance

```bash
./scripts/kiro-auth.sh --profile AYBconsole
# (opens SSM session — you don't have to run the kiro auth)
```

Or manually:

```bash
aws ssm start-session --target INSTANCE_ID --region ca-central-1 --profile AYBconsole
```

### View logs

```bash
journalctl -u nanoclaw -f                        # live
journalctl -u nanoclaw --since "1 hour ago"       # recent
```

### Restart service

```bash
sudo systemctl restart nanoclaw
```

### Update secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/secrets \
  --secret-string '{"ASSISTANT_NAME":"Andy","ANTHROPIC_API_KEY":"sk-ant-..."}' \
  --region ca-central-1 --profile AYBconsole
```

## Troubleshooting

### SSO token expired

```bash
aws sso login --profile AYBconsole
```

### Service won't start

```bash
cat /var/log/user-data.log              # first-boot issues
journalctl -u nanoclaw --no-pager -n 50 # runtime issues
```

### "No channels connected"

WhatsApp channel code missing. Redeploy local code which includes `src/channels/whatsapp.ts`:

```bash
./scripts/deploy-aws.sh --local --skip-container --profile AYBconsole
```

### npm build fails

- `tsc: command not found` — full `npm install` needed (not `--production`), then build, then prune
- husky prepare fails — use `--ignore-scripts` flag
- `better-sqlite3` native module error — run `npm rebuild better-sqlite3` after prune

### Instance replaced by spot interruption

Data persists on EBS. The new instance auto-provisions via user-data. You may need to:
1. Re-authenticate kiro-cli: `./scripts/kiro-auth.sh --profile AYBconsole`
2. Re-authenticate WhatsApp (only if linked device expired)

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
