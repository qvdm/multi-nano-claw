import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readEnvFile, initSecrets, _resetSecretsCache, _setSecretsCache } from './env.js';

beforeEach(() => {
  vi.restoreAllMocks();
  _resetSecretsCache();
});

// --- readEnvFile with .env fallback ---

describe('readEnvFile', () => {
  it('reads values from .env file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(
      'FOO=bar\nBAZ=qux\nIGNORED=value\n',
    );

    const result = readEnvFile(['FOO', 'BAZ']);

    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty object when .env is missing', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    const result = readEnvFile(['FOO']);

    expect(result).toEqual({});
  });

  it('strips quotes from values', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(
      'A="double"\nB=\'single\'\n',
    );

    const result = readEnvFile(['A', 'B']);

    expect(result).toEqual({ A: 'double', B: 'single' });
  });

  it('skips comments and empty lines', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(
      '# comment\n\nKEY=value\n',
    );

    const result = readEnvFile(['KEY']);

    expect(result).toEqual({ KEY: 'value' });
  });
});

// --- Secrets Manager cache ---

describe('readEnvFile with secrets cache', () => {
  it('returns cached values when secrets cache is populated', () => {
    _setSecretsCache({ API_KEY: 'from-sm', OTHER: 'also-from-sm' });

    // Should not read .env at all
    const spy = vi.spyOn(fs, 'readFileSync');
    const result = readEnvFile(['API_KEY', 'OTHER']);

    expect(result).toEqual({ API_KEY: 'from-sm', OTHER: 'also-from-sm' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to .env for keys not in cache', () => {
    _setSecretsCache({ API_KEY: 'from-sm' });

    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(
      'LOCAL_KEY=from-env\n',
    );

    const result = readEnvFile(['API_KEY', 'LOCAL_KEY']);

    expect(result).toEqual({ API_KEY: 'from-sm', LOCAL_KEY: 'from-env' });
  });

  it('prefers cache over .env', () => {
    _setSecretsCache({ KEY: 'from-cache' });

    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('KEY=from-file\n');

    const result = readEnvFile(['KEY']);

    expect(result).toEqual({ KEY: 'from-cache' });
  });
});

// --- initSecrets ---

describe('initSecrets', () => {
  const originalEnv = process.env.NANOCLAW_SECRETS_ARN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NANOCLAW_SECRETS_ARN;
    } else {
      process.env.NANOCLAW_SECRETS_ARN = originalEnv;
    }
  });

  it('is a no-op when NANOCLAW_SECRETS_ARN is not set', async () => {
    delete process.env.NANOCLAW_SECRETS_ARN;

    await initSecrets();

    // Cache should remain null — .env fallback still works
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('KEY=env-value\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'env-value' });
  });
});
