/**
 * Kiro CLI Runner for NanoClaw
 * Spawns kiro-cli as an alternative LLM provider in host or container mode.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  KIRO_CLI_PATH,
  KIRO_TIMEOUT,
  TIMEZONE,
} from './config.js';

/** Strip ANSI escape sequences from kiro-cli output */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
import { ContainerInput, ContainerOutput } from './container-runner.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
} from './container-runtime.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/**
 * Write a temporary .kiro/agents/nanoclaw.json agent config so kiro-cli
 * discovers the NanoClaw IPC MCP server.
 */
function writeKiroAgentConfig(groupDir: string, ipcDir: string): void {
  const kiroAgentsDir = path.join(groupDir, '.kiro', 'agents');
  fs.mkdirSync(kiroAgentsDir, { recursive: true });

  // Point to the compiled ipc-mcp-stdio.js from the host build
  const mcpStdioPath = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );

  const agentConfig = {
    name: 'nanoclaw',
    description:
      'NanoClaw IPC tools — send messages, schedule tasks, manage groups',
    tools: [
      {
        type: 'mcp',
        server_name: 'nanoclaw-ipc',
        command: 'node',
        args: [mcpStdioPath],
        env: {
          NANOCLAW_IPC_DIR: ipcDir,
          NANOCLAW_CHAT_JID: '', // populated per-invocation
          NANOCLAW_GROUP_FOLDER: '', // populated per-invocation
          NANOCLAW_IS_MAIN: '0',
        },
      },
    ],
  };

  fs.writeFileSync(
    path.join(kiroAgentsDir, 'nanoclaw.json'),
    JSON.stringify(agentConfig, null, 2),
  );
}

/**
 * Update the nanoclaw agent config with per-invocation values.
 */
function updateKiroAgentEnv(
  groupDir: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): void {
  const configPath = path.join(groupDir, '.kiro', 'agents', 'nanoclaw.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const tool of config.tools || []) {
      if (tool.env) {
        tool.env.NANOCLAW_CHAT_JID = chatJid;
        tool.env.NANOCLAW_GROUP_FOLDER = groupFolder;
        tool.env.NANOCLAW_IS_MAIN = isMain ? '1' : '0';
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    // Config doesn't exist yet, will be created on next call
  }
}

/**
 * Read kiro-specific config from .env.
 * kiro-cli uses device code auth (not API keys), so only optional
 * config values are read here.
 */
function readKiroEnvConfig(): Record<string, string> {
  return readEnvFile(['KIRO_MODEL']);
}

/**
 * Run kiro-cli in host mode — spawns kiro-cli directly as a child process.
 */
async function runKiroHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Write/update MCP agent config for kiro-cli
  writeKiroAgentConfig(groupDir, ipcDir);
  updateKiroAgentEnv(groupDir, input.chatJid, input.groupFolder, input.isMain);

  const timeout = group.containerConfig?.timeout || KIRO_TIMEOUT;
  const envConfig = readKiroEnvConfig();
  const processName = `kiro-${group.folder}-${Date.now()}`;

  // Build kiro-cli args
  const args = ['chat', '--no-interactive', '--trust-all-tools'];

  // Session resume
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  // The prompt is the last argument
  args.push(input.prompt);

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  logger.info(
    { group: group.name, processName, hasSession: !!input.sessionId },
    'Spawning kiro-cli (host mode)',
  );

  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TZ: TIMEZONE,
      NO_COLOR: '1', // suppress ANSI escape sequences
      // Pass config as env vars for kiro-cli
      ...envConfig,
    };

    const proc = spawn(KIRO_CLI_PATH, args, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Kiro CLI timeout, killing process',
      );
      proc.kill('SIGTERM');
      // Force kill after 10s grace
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 10000);
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ kiro: group.folder }, line);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now();

      // Write log file
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `kiro-${ts}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Kiro CLI Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
          `Session: ${input.sessionId || 'new'}`,
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        ].join('\n'),
      );

      if (timedOut) {
        const result: ContainerOutput = {
          status: 'error',
          result: null,
          error: `Kiro CLI timed out after ${timeout}ms`,
        };
        if (onOutput) {
          onOutput(result).then(() => resolve(result));
        } else {
          resolve(result);
        }
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, stderr: stderr.slice(-200) },
          'Kiro CLI exited with error',
        );
        const result: ContainerOutput = {
          status: 'error',
          result: null,
          error: `Kiro CLI exited with code ${code}: ${stderr.slice(-200)}`,
        };
        if (onOutput) {
          onOutput(result).then(() => resolve(result));
        } else {
          resolve(result);
        }
        return;
      }

      // Parse kiro-cli output — it writes plain text to stdout
      const text = stripAnsi(stdout).trim();

      // Try to extract session ID from stderr (kiro-cli logs session info there)
      let newSessionId: string | undefined;
      const sessionMatch = stderr.match(/session[_-]?id[:\s]+(\S+)/i);
      if (sessionMatch) {
        newSessionId = sessionMatch[1];
      }

      const result: ContainerOutput = {
        status: 'success',
        result: text || null,
        newSessionId,
      };

      logger.info(
        { group: group.name, hasResult: !!text, newSessionId },
        'Kiro CLI completed',
      );

      if (onOutput) {
        onOutput(result).then(() => resolve(result));
      } else {
        resolve(result);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error(
        { group: group.name, processName, error: err },
        'Kiro CLI spawn error',
      );
      const result: ContainerOutput = {
        status: 'error',
        result: null,
        error: `Kiro CLI spawn error: ${err.message}`,
      };
      resolve(result);
    });
  });
}

/**
 * Run kiro-cli in container mode — spawns Docker with kiro-cli entrypoint.
 */
async function runKiroContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const timeout = group.containerConfig?.timeout || KIRO_TIMEOUT;
  const envConfig = readKiroEnvConfig();
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-kiro-${safeName}-${Date.now()}`;

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Build docker args
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass kiro config as env vars
  for (const [key, value] of Object.entries(envConfig)) {
    if (value) args.push('-e', `${key}=${value}`);
  }

  // Pass IPC env vars
  args.push('-e', `NANOCLAW_IPC_DIR=/workspace/ipc`);
  args.push('-e', `NANOCLAW_CHAT_JID=${input.chatJid}`);
  args.push('-e', `NANOCLAW_GROUP_FOLDER=${input.groupFolder}`);
  args.push('-e', `NANOCLAW_IS_MAIN=${input.isMain ? '1' : '0'}`);

  // Run as host user if needed
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Mount group dir and IPC
  args.push('-v', `${groupDir}:/workspace/group`);
  args.push('-v', `${ipcDir}:/workspace/ipc`);

  // Mount global memory for non-main groups
  if (!input.isMain) {
    const globalDir = path.join(process.cwd(), 'groups', 'global');
    if (fs.existsSync(globalDir)) {
      args.push(...readonlyMountArgs(globalDir, '/workspace/global'));
    }
  }

  args.push(CONTAINER_IMAGE);

  // Override entrypoint to run kiro-cli instead of agent-runner
  const kiroArgs = [
    'kiro-cli',
    'chat',
    '--no-interactive',
    '--trust-all-tools',
  ];
  if (input.sessionId) {
    kiroArgs.push('--resume', input.sessionId);
  }
  kiroArgs.push(input.prompt);
  args.push(...kiroArgs);

  logger.info(
    { group: group.name, containerName, hasSession: !!input.sessionId },
    'Spawning kiro-cli (container mode)',
  );

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Kiro container timeout, stopping',
      );
      spawn(CONTAINER_RUNTIME_BIN, ['stop', containerName], {
        stdio: 'pipe',
      });
    }, timeout);

    container.stdin.end();

    container.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ kiro: group.folder }, line);
      }
    });

    container.on('close', (code) => {
      clearTimeout(timer);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `kiro-container-${ts}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Kiro Container Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        ].join('\n'),
      );

      if (timedOut) {
        const result: ContainerOutput = {
          status: 'error',
          result: null,
          error: `Kiro container timed out after ${timeout}ms`,
        };
        if (onOutput) {
          onOutput(result).then(() => resolve(result));
        } else {
          resolve(result);
        }
        return;
      }

      if (code !== 0) {
        const result: ContainerOutput = {
          status: 'error',
          result: null,
          error: `Kiro container exited with code ${code}: ${stderr.slice(-200)}`,
        };
        if (onOutput) {
          onOutput(result).then(() => resolve(result));
        } else {
          resolve(result);
        }
        return;
      }

      const text = stripAnsi(stdout).trim();
      let newSessionId: string | undefined;
      const sessionMatch = stderr.match(/session[_-]?id[:\s]+(\S+)/i);
      if (sessionMatch) {
        newSessionId = sessionMatch[1];
      }

      const result: ContainerOutput = {
        status: 'success',
        result: text || null,
        newSessionId,
      };

      logger.info(
        { group: group.name, hasResult: !!text, newSessionId },
        'Kiro container completed',
      );

      if (onOutput) {
        onOutput(result).then(() => resolve(result));
      } else {
        resolve(result);
      }
    });

    container.on('error', (err) => {
      clearTimeout(timer);
      const result: ContainerOutput = {
        status: 'error',
        result: null,
        error: `Kiro container spawn error: ${err.message}`,
      };
      resolve(result);
    });
  });
}

/**
 * Run kiro-cli agent. Dispatches to host or container mode based on group config.
 * Default mode for kiro is 'host'.
 */
export async function runKiroAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const mode = group.containerConfig?.providerMode || 'host';

  if (mode === 'container') {
    return runKiroContainerAgent(group, input, onProcess, onOutput);
  }

  return runKiroHostAgent(group, input, onProcess, onOutput);
}
