/**
 * Everything that talks to Google lives here, behind the GoogleGateway
 * interface, so the HTTP layer can be tested with a fake.
 *
 * All calls go through the official client libraries:
 *   - google-auth-library            OAuth 2.0 code exchange, ID token check, revoke
 *   - @google-cloud/resource-manager Cloud Resource Manager projects.search
 */
import { OAuth2Client } from 'google-auth-library';
import { ProjectsClient } from '@google-cloud/resource-manager';
import { ApiError, fromGoogleError } from './errors.js';

/** OAuth scopes requested at sign-in. Each is explained in README.md. */
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'] as const;

export interface SignedInUser {
  email: string;
  /** Whether Google says the account owns that address. The allowlist needs it (D-16). */
  emailVerified: boolean;
  accessToken: string;
  expiresAt: Date;
}

export interface Project {
  projectId: string;
  displayName: string;
}

export interface GoogleGateway {
  /** URL of Google's consent screen for this app, carrying `state`. */
  authUrl(state: string): string;
  /** Exchange the code from the callback for an access token and the visitor's email. */
  exchangeCode(code: string): Promise<SignedInUser>;
  /** Revoke an access token at Google. Failures are swallowed by the caller. */
  revoke(accessToken: string): Promise<void>;
  /** Active projects the visitor can see. */
  listProjects(accessToken: string): Promise<Project[]>;
}

export interface GoogleGatewayOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Default lifetime to assume when Google omits `expiry_date` (it never should). */
const FALLBACK_TOKEN_LIFETIME_MS = 55 * 60 * 1000;

export function createGoogleGateway(opts: GoogleGatewayOptions): GoogleGateway {
  const newOAuthClient = () =>
    new OAuth2Client({ clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri: opts.redirectUri });

  return {
    authUrl(state) {
      return newOAuthClient().generateAuthUrl({
        access_type: 'online', // no refresh token: nothing outlives the session (D-7)
        scope: [...SCOPES],
        state,
        prompt: 'select_account',
      });
    },

    async exchangeCode(code) {
      const client = newOAuthClient();
      let tokens;
      try {
        ({ tokens } = await client.getToken(code));
      } catch (err) {
        throw fromGoogleError(err, 'complete the Google sign-in');
      }
      if (!tokens.access_token) {
        throw new ApiError(
          'UPSTREAM_ERROR',
          'Google did not return an access token.',
          'Try signing in again. If it keeps failing, the OAuth client may be misconfigured.',
        );
      }

      let email: string | undefined;
      let emailVerified = false;
      if (tokens.id_token) {
        try {
          const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: opts.clientId });
          const payload = ticket.getPayload();
          email = payload?.email;
          emailVerified = payload?.email_verified === true;
        } catch (err) {
          throw fromGoogleError(err, 'verify your Google identity');
        }
      }
      if (!email) {
        try {
          const info = await client.getTokenInfo(tokens.access_token);
          email = info.email;
          emailVerified = info.email_verified === true;
        } catch (err) {
          throw fromGoogleError(err, 'read your Google account email');
        }
      }
      if (!email) {
        throw new ApiError(
          'UPSTREAM_ERROR',
          'Google did not tell us which account signed in.',
          'Try again and make sure you allow the app to see your email address.',
        );
      }

      const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + FALLBACK_TOKEN_LIFETIME_MS);
      return { email, emailVerified, accessToken: tokens.access_token, expiresAt };
    },

    async revoke(accessToken) {
      await newOAuthClient().revokeToken(accessToken);
    },

    async listProjects(accessToken) {
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: accessToken });
      const client = new ProjectsClient({ authClient });
      try {
        const projects: Project[] = [];
        for await (const p of client.searchProjectsAsync({ query: 'state:ACTIVE' }, { autoPaginate: false })) {
          if (!p.projectId) continue;
          projects.push({ projectId: p.projectId, displayName: p.displayName || p.projectId });
        }
        projects.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.projectId.localeCompare(b.projectId));
        return projects;
      } catch (err) {
        throw fromGoogleError(err, 'list your Google Cloud projects');
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
