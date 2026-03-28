import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * In-memory cache of secrets fetched from AWS Secrets Manager.
 * Populated by initSecrets() during startup. When null, readEnvFile
 * falls back to the .env file (local development).
 */
let secretsCache: Record<string, string> | null = null;

/**
 * Initialize secrets from AWS Secrets Manager if NANOCLAW_SECRETS_ARN
 * is set. Call once at startup before any readEnvFile() calls that
 * need secrets. No-op when running locally without the env var.
 */
export async function initSecrets(): Promise<void> {
  const secretArn = process.env.NANOCLAW_SECRETS_ARN;
  if (!secretArn) {
    logger.debug('NANOCLAW_SECRETS_ARN not set, using .env for secrets');
    return;
  }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );
    const client = new SecretsManagerClient({});
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );

    if (!response.SecretString) {
      throw new Error('Secret value is empty');
    }

    secretsCache = JSON.parse(response.SecretString);
    logger.info('Secrets loaded from AWS Secrets Manager');
  } catch (err) {
    logger.error({ err }, 'Failed to load secrets from Secrets Manager');
    throw err;
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * If secrets have been loaded from Secrets Manager (via initSecrets),
 * those values take priority. Falls back to the .env file for any
 * keys not found in the cache.
 *
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const remaining: string[] = [];

  // Check Secrets Manager cache first
  if (secretsCache) {
    for (const key of keys) {
      if (secretsCache[key]) {
        result[key] = secretsCache[key];
      } else {
        remaining.push(key);
      }
    }
  } else {
    remaining.push(...keys);
  }

  // Fall back to .env for uncached keys
  if (remaining.length === 0) return result;

  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return result;
  }

  const wanted = new Set(remaining);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/** Reset secrets cache (for testing). */
export function _resetSecretsCache(): void {
  secretsCache = null;
}

/** Set secrets cache directly (for testing). */
export function _setSecretsCache(cache: Record<string, string> | null): void {
  secretsCache = cache;
}
