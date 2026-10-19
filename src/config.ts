/**
 * Platform configuration.
 *
 * Every value here is required and none has a fallback. A missing value fails at startup
 * naming the variable, rather than booting into wrong behaviour that surfaces later,
 * somewhere unrelated, as a mystery. A silent default turns "you forgot to set X" into a
 * buried bug; loud failure is strictly better.
 *
 * Nothing tenant-scoped belongs here. The test: if a second tenant would need a different
 * value, it is data and lives in the store.
 */

const OP_REFERENCE_PREFIX = 'op://';
const LOCAL_RUN_COMMAND = 'op run --env-file=.env.local -- npm start';

/**
 * Throws if any value in `env` is still a 1Password reference.
 *
 * The committed `.env.local` holds its secrets as references (`op://vault/item/field`), and only
 * `op run --env-file=.env.local -- <cmd>` resolves them. Started without op run, a reference
 * would reach the app as a literal credential and fail later, somewhere else, as a bad token.
 * This stops it at startup instead, naming every unresolved variable. Deployed tiers never set
 * a reference (Cloud Run injects real values), so it never fires there.
 *
 * The same check as `assertNoOpReferences` in scripts/lib/env-guard.mjs. It is repeated here
 * because the image build compiles `src/` alone and cannot import from `scripts/`.
 */
export function assertNoOpReferences(env: NodeJS.ProcessEnv): void {
  const unresolved = Object.keys(env)
    .filter((key) => env[key]?.startsWith(OP_REFERENCE_PREFIX))
    .sort();
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved 1Password reference in ${unresolved.join(', ')}: the value is still op://…, ` +
        `so this was started without op run. Run it as: ${LOCAL_RUN_COMMAND}`,
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. It is required platform configuration — see .env.local. ` +
        'Refusing to start rather than guess.',
    );
  }
  return value;
}

/** For a genuinely optional capability whose absence can only turn a feature OFF, never wrong. */
function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export interface Config {
  databaseUrl: string;
  port: number;
  /**
   * NOT read by any caller. It is the value behind `applications.token_ref` for the
   * platform's Discord application, and is reached only through `getRest(applicationId)`.
   */
  discordBotToken: string;
  /**
   * The Discord application's Ed25519 PUBLIC key, used to verify inbound interactions.
   *
   * Optional on purpose — not a smuggled silent default. It gates an ADDITIVE capability: when
   * it is absent the interactions endpoint answers 503 and webhooks are wholly unaffected, so a
   * missing value can only turn the feature off, never produce wrong behaviour. When it IS set,
   * it is validated at boot — a malformed key throws in `createPublicKey`, loudly, at startup.
   */
  discordPublicKey?: string;
}

export function loadConfig(): Config {
  assertNoOpReferences(process.env);
  const port = Number(required('PORT'));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${process.env.PORT}".`);
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    port,
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    discordPublicKey: optional('DISCORD_PUBLIC_KEY'),
  };
}
