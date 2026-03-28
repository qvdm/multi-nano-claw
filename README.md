<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
Using Claude Code, NanoClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal.

### Running Locally

NanoClaw supports two LLM providers: **Claude** (default, runs in containers) and **kiro-cli** (runs on the host or in containers). You can use either or both at the same time — each group picks its own provider.

#### Claude (default)

Requires Docker (or Apple Container on macOS). Agents run in isolated Linux containers via the Claude Agent SDK.

```bash
# Install dependencies
npm install

# Set up credentials in .env
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
# or: CLAUDE_CODE_OAUTH_TOKEN=...

# Build the container image
./container/build.sh

# Add a channel and register your main chat
claude   # then run /add-whatsapp or /add-telegram

# Start
npm run dev
```

#### kiro-cli

Runs kiro-cli directly on the host as a child process — no Docker needed for kiro groups.

```bash
# Install kiro-cli
curl -fsSL https://cli.kiro.dev/install | bash

# Install dependencies
npm install

# Authenticate kiro-cli (opens browser for device code flow)
kiro-cli auth login

# Add a channel
claude   # then run /add-whatsapp or /add-telegram

# Start
npm run dev
```

After registering a group, set its provider to kiro:

```bash
# In sqlite (or via the agent's register_group tool with containerConfig)
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{\"provider\":\"kiro\",\"providerMode\":\"host\"}' WHERE folder = 'whatsapp_main'"
```

#### Mixed setup (both providers)

Register different groups with different providers. They run independently:

```
Group A (main self-chat) → provider: kiro, host mode
Group B (work group)     → provider: claude, container mode
Group C (family group)   → provider: kiro, host mode
```

See [docs/KIRO-PROVIDER.md](docs/KIRO-PROVIDER.md) for full configuration details.

### Deploying to AWS

NanoClaw runs on a single EC2 spot instance (~$10/month) with all infrastructure defined in CDK. Zero inbound ports — all channels use outbound connections and management is via SSM (no SSH).

#### Prerequisites

- AWS CLI configured with credentials
- Node.js 20+ (for CDK)
- Docker (to build the agent container image locally, or build on-instance)

#### 1. Deploy infrastructure

```bash
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy
```

This creates:
- EC2 spot instance (`t4g.small`, ARM Graviton) in an Auto Scaling Group
- Persistent EBS volume for data (SQLite DB, groups, sessions, logs)
- Secrets Manager secret (`nanoclaw/secrets`)
- CloudWatch log group
- Daily EBS backups (7-day retention)

#### 2. Add secrets

The CDK stack creates a placeholder secret. Populate it with your actual keys:

```bash
aws secretsmanager put-secret-value \
  --secret-id nanoclaw/secrets \
  --secret-string '{
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "ASSISTANT_NAME": "Andy",
    "ASSISTANT_NAME": "Andy"
  }'
```

Add channel tokens as needed (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, etc.). NanoClaw reads all secrets from Secrets Manager automatically when `NANOCLAW_SECRETS_ARN` is set — no `.env` file on the instance.

#### 3. Connect to the instance

```bash
# Find instance ID
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names nanoclaw \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

# Connect via SSM (no SSH needed)
aws ssm start-session --target $INSTANCE_ID
```

#### 4. Set up channels and register groups

On the instance, authenticate your messaging channel and register your main chat:

```bash
cd /opt/nanoclaw
claude   # then run /add-whatsapp or /add-telegram
```

To use kiro on AWS, install kiro-cli on the instance and authenticate via `kiro-cli auth login` (device code flow — displays a URL you open in your browser). Then set the provider on your group (same as local setup).

#### 5. Deploy updates

Push code changes and deploy without SSH:

```bash
./scripts/deploy-aws.sh $INSTANCE_ID
```

This uses SSM Run Command to pull, build, and restart the service on the instance.

#### Key differences from local

| | Local | AWS |
|---|---|---|
| Secrets | `.env` file | Secrets Manager (`NANOCLAW_SECRETS_ARN`) |
| Service | `launchctl` / `systemctl --user` | `systemctl` (systemd) |
| Container limit | `MAX_CONCURRENT_CONTAINERS=5` | `=1` (2GB RAM budget) |
| Management | Direct terminal | SSM Session Manager |
| Data persistence | Local filesystem | Separate EBS volume (survives spot replacement) |
| Cost | Free | ~$10/month |

For full details, see [docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. NanoClaw is the first personal AI assistant to support agent swarms.
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

**Session Management**
- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Provider dispatch --> Agent --> Response
                                             │
                                   ┌─────────┴──────────┐
                                   │                     │
                            Claude (container)     kiro-cli (host)
                            Docker/Apple Container   child process
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Each group can use a different LLM provider. Claude agents execute in isolated Linux containers; kiro-cli agents run directly on the host. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/provider-dispatch.ts` - Routes to Claude container or kiro-cli based on group config
- `src/container-runner.ts` - Spawns streaming Claude agent containers
- `src/kiro-runner.ts` - Spawns kiro-cli in host or container mode
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports multiple LLM providers per-group:

- **Claude** (default) — Uses the Claude Agent SDK in containers. Supports any Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `.env`.
- **kiro-cli** — Runs kiro-cli on the host or in containers. Set `provider: "kiro"` in a group's config. See [docs/KIRO-PROVIDER.md](docs/KIRO-PROVIDER.md).

For Claude-compatible endpoints (Ollama, Together AI, Fireworks, custom deployments):

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
