// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoOpReferences as fleetGuard } from '../../scripts/lib/env-guard.mjs';
import { assertNoOpReferences, loadConfig } from '../../src/config.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const configModule = fileURLToPath(new URL('../../src/config.ts', import.meta.url));

describe('assertNoOpReferences (server startup guard)', () => {
  it('passes when every value is resolved', () => {
    expect(() =>
      assertNoOpReferences({ DISCORD_BOT_TOKEN: 'resolved', PORT: '8080', EMPTY: undefined }),
    ).not.toThrow();
  });

  it('throws naming every unresolved variable and the op run command', () => {
    const run = () =>
      assertNoOpReferences({
        DISCORD_BOT_TOKEN: 'op://app-secrets/snackbyte-chat-automations.local/DISCORD_BOT_TOKEN',
        PORT: '8080',
        DATABASE_URL: 'op://app-secrets/snackbyte-chat-automations.local/DATABASE_URL',
      });
    expect(run).toThrow(/DATABASE_URL, DISCORD_BOT_TOKEN/);
    expect(run).toThrow(/op run --env-file=\.env\.local -- npm start/);
    expect(run).not.toThrow(/PORT/);
  });

  // src/ cannot import scripts/lib/env-guard.mjs (the image build compiles src/ alone), so the
  // server carries its own copy. This keeps the two from drifting apart.
  it('behaves exactly like the fleet guard in scripts/lib/env-guard.mjs', () => {
    const env = { B_TOKEN: 'op://v/i/B_TOKEN', PORT: '8080', A_TOKEN: 'op://v/i/A_TOKEN' };
    const messageOf = (run: () => void): string => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return 'did not throw';
    };
    expect(messageOf(() => assertNoOpReferences(env))).toBe(
      messageOf(() => fleetGuard(env, 'op run --env-file=.env.local -- npm start')),
    );
    expect(() => assertNoOpReferences({ PORT: '8080' })).not.toThrow();
    expect(() => fleetGuard({ PORT: '8080' }, 'cmd')).not.toThrow();
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubResolvedConfig(): void {
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres@localhost:55432/test');
    vi.stubEnv('PORT', '8080');
    vi.stubEnv('DISCORD_BOT_TOKEN', 'plaintext');
    vi.stubEnv('DISCORD_PUBLIC_KEY', '');
  }

  it('loads resolved values', () => {
    stubResolvedConfig();
    expect(loadConfig()).toEqual({
      databaseUrl: 'postgresql://postgres@localhost:55432/test',
      port: 8080,
      discordBotToken: 'plaintext',
      discordPublicKey: undefined,
    });
  });

  it('refuses to start while a value is still a 1Password reference', () => {
    stubResolvedConfig();
    vi.stubEnv('DISCORD_BOT_TOKEN', 'op://app-secrets/snackbyte-chat-automations.local/X');
    expect(() => loadConfig()).toThrow(/Unresolved 1Password reference in DISCORD_BOT_TOKEN/);
  });

  it('points a missing value at the committed .env.local', () => {
    stubResolvedConfig();
    vi.stubEnv('DATABASE_URL', '');
    expect(() => loadConfig()).toThrow(/DATABASE_URL is not set\. .* see \.env\.local\./);
  });
});

describe('the committed .env.local without op run', () => {
  // Node's --env-file does not resolve op:// references, so this is exactly what the server sees
  // when it is started from the committed file and op run is forgotten.
  it('stops the server at startup, naming the unresolved variable', () => {
    const result = spawnSync(
      'node',
      [
        '--env-file=.env.local',
        '--input-type=module',
        '-e',
        `const { loadConfig } = await import(${JSON.stringify(configModule)}); loadConfig();`,
      ],
      { cwd: repoRoot, env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unresolved 1Password reference in DISCORD_BOT_TOKEN');
    expect(result.stderr).toContain('op run --env-file=.env.local -- npm start');
  });
});
