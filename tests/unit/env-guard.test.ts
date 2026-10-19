// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNoOpReferences,
  findRawValues,
  isCheckedEnvFile,
} from '../../scripts/lib/env-guard.mjs';

const checkEnvScript = fileURLToPath(new URL('../../scripts/check-env-files.mjs', import.meta.url));

describe('assertNoOpReferences (fleet copy)', () => {
  it('passes when every value is resolved', () => {
    expect(() =>
      assertNoOpReferences({ DISCORD_BOT_TOKEN: 'real', PORT: '8080', EMPTY: undefined }, 'cmd'),
    ).not.toThrow();
  });

  it('throws naming every unresolved variable and the op run command', () => {
    const run = () =>
      assertNoOpReferences(
        {
          DISCORD_BOT_TOKEN: 'op://app-secrets/snackbyte-chat-automations.local/DISCORD_BOT_TOKEN',
          PORT: '8080',
          CLICKUP_TOKEN: 'op://app-secrets/snackbyte-chat-automations.local/CLICKUP_TOKEN',
        },
        'op run --env-file=.env.local -- npm start',
      );
    expect(run).toThrow(/CLICKUP_TOKEN, DISCORD_BOT_TOKEN/);
    expect(run).toThrow(/op run --env-file=\.env\.local -- npm start/);
    expect(run).not.toThrow(/PORT/);
  });
});

describe('findRawValues (committed-file check)', () => {
  it('accepts references, empty values and declared config', () => {
    const text = [
      '# config: DATABASE_URL, PORT',
      '# config: LOG_LEVEL',
      'DATABASE_URL=postgresql://postgres@localhost:55432/test',
      'PORT=8080',
      'LOG_LEVEL=debug',
      'DISCORD_PUBLIC_KEY=',
      'QUOTED_EMPTY=""',
      'DISCORD_BOT_TOKEN=op://app-secrets/snackbyte-chat-automations.local/DISCORD_BOT_TOKEN',
      'export WEBHOOK_SECRET="op://app-secrets/snackbyte-chat-automations.local/WEBHOOK_SECRET"',
      'INLINE=op://vault/item/field # trailing comment',
      'QUOTED_INLINE="op://vault/item/field" # trailing comment',
      'EMPTY_INLINE= # empty locally',
      '',
      '   # indented comment',
    ].join('\n');
    expect(findRawValues(text)).toEqual([]);
  });

  it('flags text hidden where dotenv would not read it as a comment or a reference', () => {
    const findings = findRawValues(
      ['HASH_START=#plaintext', 'AFTER_QUOTE="" plaintext', 'UNCLOSED="op://vault/item/field'].join(
        '\n',
      ),
    );
    expect(findings.map((f) => f.key)).toEqual(['HASH_START', 'AFTER_QUOTE', 'UNCLOSED']);
  });

  it('accepts a config declaration that comes after the assignment', () => {
    expect(findRawValues('PORT=8080\n# config: PORT\n')).toEqual([]);
  });

  it('flags an undeclared raw value by line and key, never echoing the value', () => {
    const findings = findRawValues(
      ['# config: PORT', 'PORT=8080', 'DISCORD_BOT_TOKEN=plaintext'].join('\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 3, key: 'DISCORD_BOT_TOKEN' });
    expect(JSON.stringify(findings)).not.toContain('plaintext');
  });

  it('flags raw values behind export, quotes and spacing', () => {
    const findings = findRawValues(
      ['export A=raw', "B='raw'", 'C = raw', 'D="op-not-a-reference"'].join('\n'),
    );
    expect(findings.map((f) => f.key)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('flags a line that is not KEY=value (e.g. a pasted key body)', () => {
    const findings = findRawValues('PORT=8080\n-----BEGIN PRIVATE KEY-----\n# config: PORT\n');
    expect(findings).toEqual([{ line: 2, key: null, reason: 'not a KEY=value line' }]);
  });

  it('does not treat a declaration of one key as covering another', () => {
    expect(findRawValues('# config: PORT\nPORTS=1,2\n').map((f) => f.key)).toEqual(['PORTS']);
  });
});

describe('isCheckedEnvFile', () => {
  // Every tracked env file is checked, examples included: a real secret pasted into an example
  // is the classic leak, and an exemption would let it through.
  it.each([
    '.env',
    '.env.local',
    '.env.staging',
    '.env.prod',
    '.env.local.example',
    'config/.env.sample',
    'service.env',
  ])('checks %s', (path) => {
    expect(isCheckedEnvFile(path)).toBe(true);
  });

  it.each(['src/env.ts', '.envrc', 'docs/environment.md'])('skips %s', (path) => {
    expect(isCheckedEnvFile(path)).toBe(false);
  });
});

describe('check-env end to end', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a raw value in a tracked env file and names it without the value', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(
      join(dir, '.env.local'),
      '# config: PORT\nPORT=8080\nDATABASE_URL=op://v/i/DATABASE_URL\nDISCORD_BOT_TOKEN=plaintext\n',
    );
    writeFileSync(join(dir, '.env.local.example'), 'DISCORD_BOT_TOKEN=pasted-into-the-example\n');
    writeFileSync(join(dir, '.env.staging'), 'DISCORD_BOT_TOKEN=not-tracked-so-not-checked\n');
    execFileSync('git', ['add', '.env.local', '.env.local.example'], { cwd: dir });

    const failing = spawnSync('node', [checkEnvScript], { cwd: dir, encoding: 'utf8' });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('.env.local:4 DISCORD_BOT_TOKEN');
    expect(failing.stderr).toContain('.env.local.example:1 DISCORD_BOT_TOKEN');
    expect(failing.stderr).not.toContain('.env.staging');
    expect(failing.stderr).not.toContain('plaintext');
    expect(failing.stderr).not.toContain('pasted-into-the-example');

    writeFileSync(
      join(dir, '.env.local'),
      '# config: PORT\nPORT=8080\nDISCORD_BOT_TOKEN=op://v/i/DISCORD_BOT_TOKEN\n',
    );
    writeFileSync(
      join(dir, '.env.local.example'),
      'DISCORD_BOT_TOKEN=op://v/i/DISCORD_BOT_TOKEN\n',
    );
    const passing = spawnSync('node', [checkEnvScript], { cwd: dir, encoding: 'utf8' });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('check:env OK: 2 tracked env file(s)');
  });
});
