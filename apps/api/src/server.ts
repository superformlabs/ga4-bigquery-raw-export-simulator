/**
 * Entry point: load .env, build the app, listen on PORT.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createCloudGateway } from './cloud.js';
import { ConfigError, loadConfig } from './config.js';
import { createGoogleGateway } from './google.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// apps/api/.env, if present. Never committed.
try {
  process.loadEnvFile(path.resolve(here, '..', '.env'));
} catch {
  // No .env file: rely on the environment.
}

// The generator image the visitor's Cloud Run job will pull. The deploy role
// writes it to infra/IMAGE (one line); GENERATOR_IMAGE overrides it, and is
// the only source once the API is hosted away from the repository.
if (!process.env.GENERATOR_IMAGE?.trim()) {
  try {
    process.env.GENERATOR_IMAGE = readFileSync(path.resolve(here, '..', '..', '..', 'infra', 'IMAGE'), 'utf8').trim();
  } catch {
    // Not in the repository: loadConfig reports the missing value.
  }
}

function resolveVersion(): string {
  if (process.env.GIT_SHA?.trim()) return process.env.GIT_SHA.trim();
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const google = createGoogleGateway({
  clientId: config.googleClientId,
  clientSecret: config.googleClientSecret,
  redirectUri: config.googleRedirectUri,
});

const app = createApp({ config, google, cloud: createCloudGateway(), version: resolveVersion() });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  console.log(`Sign in at http://localhost:${info.port}/auth/login (redirect URI ${config.googleRedirectUri})`);
  const allowed = [...config.allowedEmailDomains.map((d) => `@${d}`), ...config.allowedEmails];
  console.log(allowed.length ? `Sign-in allowlist: ${allowed.join(', ')}` : 'Sign-in allowlist: none, every Google account may sign in');
  console.log(`Address of the support in the hints: ${config.supportEmail}`);
  if (config.uninstallEnabled) console.log('UNINSTALL_ENABLED is true: POST /api/install/uninstall is switched on');
});
