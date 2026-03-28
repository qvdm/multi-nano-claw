# Kiro CLI as LLM Provider

NanoClaw supports kiro-cli as an alternative LLM provider alongside the default Claude Agent SDK. Each group can independently use a different provider.

## Quick Start

Register a group with kiro as the provider:

```json
{
  "containerConfig": {
    "provider": "kiro",
    "providerMode": "host"
  }
}
```

No database migration needed — `containerConfig` is a JSON column that accepts new fields transparently.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIRO_CLI_PATH` | `kiro-cli` | Path to the kiro-cli binary |
| `KIRO_TIMEOUT` | `300000` (5 min) | Max execution time per invocation (ms) |
| `KIRO_MODEL` | — | Optional model override (read from `.env`) |

kiro-cli uses **device code authentication** (browser-based login), not API keys. Run `kiro-cli auth login` to authenticate. See [kiro-cli authentication docs](https://kiro.dev/docs/cli/authentication/) for details.

### Per-Group Settings

Set in `containerConfig` when registering a group:

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `provider` | `"claude"` \| `"kiro"` | `"claude"` | Which LLM provider to use |
| `providerMode` | `"host"` \| `"container"` | `"host"` for kiro, `"container"` for claude | Where the provider runs |

## Usage Cases

### 1. Default — Claude in Docker (unchanged)

No configuration needed. All existing groups continue to work exactly as before.

```json
{ "containerConfig": {} }
```

### 2. Kiro on Host

kiro-cli runs directly on the host machine as a child process. Simplest setup — no Docker needed for the kiro group.

```json
{
  "containerConfig": {
    "provider": "kiro",
    "providerMode": "host"
  }
}
```

**Requirements:** kiro-cli installed and on `$PATH` (or set `KIRO_CLI_PATH`).

### 3. Kiro in Docker

kiro-cli runs inside the NanoClaw container image. Provides the same isolation as Claude containers.

```json
{
  "containerConfig": {
    "provider": "kiro",
    "providerMode": "container"
  }
}
```

**Requirements:** Container image rebuilt with kiro-cli installed (add `RUN curl -fsSL https://cli.kiro.dev/install | bash` to `container/Dockerfile`, then `./container/build.sh`).

### 4. Mixed Groups

Different groups can use different providers simultaneously. One group on Claude, another on kiro — they run independently.

```
Group A: { "provider": "claude" }  -> Docker container with Agent SDK
Group B: { "provider": "kiro", "providerMode": "host" }  -> kiro-cli on host
Group C: { "provider": "kiro", "providerMode": "container" }  -> kiro-cli in Docker
```

### 5. Custom Timeout

Override the default 5-minute timeout for long-running kiro tasks:

```json
{
  "containerConfig": {
    "provider": "kiro",
    "timeout": 600000
  }
}
```

Or globally via `KIRO_TIMEOUT=600000` in `.env`.

## Deployment

### Local

Install kiro-cli on your machine, add credentials to `.env`, and register groups with `"provider": "kiro"`. Host mode is the natural fit — kiro-cli runs as a direct child process with no extra infrastructure.

```bash
# Install kiro-cli
curl -fsSL https://cli.kiro.dev/install | bash

# Authenticate (opens browser for device code flow)
kiro-cli auth login

# Start NanoClaw normally
npm run dev
```

### AWS (EC2)

kiro-cli uses device code authentication. After installing, run `kiro-cli auth login` on the instance via SSM Session Manager — it will display a URL and code to enter in your browser.

```bash
# Connect via SSM
aws ssm start-session --target <instance-id>

# Authenticate kiro-cli (displays URL + code for browser)
sudo -u ec2-user kiro-cli auth login
```

**Host mode** works on EC2 out of the box — install kiro-cli on the instance (in your deploy script or AMI) and set `KIRO_CLI_PATH` if it's not on `$PATH`.

**Container mode** requires the container image to include kiro-cli. Add the install to `container/Dockerfile` and rebuild:

```dockerfile
RUN curl -fsSL https://cli.kiro.dev/install | bash
```

Then `./container/build.sh` (or include it in your CI/deploy pipeline).

| Concern | Local | AWS |
|---------|-------|-----|
| Secrets | `.env` file | Secrets Manager (`NANOCLAW_SECRETS_ARN`) |
| kiro-cli install | Host machine | EC2 instance or container image |
| Recommended mode | `host` | `host` (simplest) or `container` (isolated) |
| Service management | `launchctl` / `systemctl --user` | `systemctl` (systemd unit) |

## How It Works

### Session Management

kiro-cli sessions are stored in the same `sessions` table as Claude sessions. When a group has a previous session, `--resume <sessionId>` is passed automatically to maintain conversation continuity.

### Follow-Up Messages

kiro-cli in `--no-interactive` mode is single-turn (processes one prompt and exits). When a follow-up message arrives for a kiro group whose process has already exited, `sendMessage()` returns `false`, causing the orchestrator to enqueue a new message check. This spawns a fresh `kiro-cli --resume` invocation with the new message.

### MCP Tools

In host mode, a `.kiro/agents/nanoclaw.json` config file is written to the group's working directory before each invocation. This gives kiro-cli access to NanoClaw's IPC tools (`send_message`, `schedule_task`, etc.) via the same MCP server used by Claude containers.

### Scheduled Tasks

Scheduled tasks respect the group's provider setting. A task for a kiro group runs via kiro-cli, and a task for a Claude group runs via the container agent — no extra configuration needed.
