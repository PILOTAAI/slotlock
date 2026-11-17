// Connecting a tenant's calendar account (RFC 0004 C1): OAuth 2.0 authorization code with PKCE
// (S256) and a random state, for Google and Microsoft identity. The sync asks only for what it uses:
// free/busy to read, and events only when bookings are written back.
import { createHash, randomBytes } from 'node:crypto';

export type OAuthProvider = 'google' | 'microsoft';

export interface OAuthClient {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  /** Where the provider sends the person back, as registered with it. */
  redirectUri: string;
  /** Microsoft only: the directory (`common`, `organizations` or a tenant id). Default `common`. */
  directory?: string;
}

export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider gave none (Google gives one at first consent only). */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

/** A failure the provider answered: invalid_grant means the person must connect again. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`OAuth token endpoint answered ${status} ${code}`);
    this.name = 'OAuthError';
  }
}

/**
 * What each provider is asked for: the list of calendars (to choose one) and free/busy, and with
 * write-back, events. Microsoft needs User.Read for the account's address.
 */
export function oauthScopes(provider: OAuthProvider, writeBack: boolean): string[] {
  if (provider === 'google') {
    return [
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      ...(writeBack ? ['https://www.googleapis.com/auth/calendar.events'] : []),
    ];
  }
  return ['offline_access', 'User.Read', writeBack ? 'Calendars.ReadWrite' : 'Calendars.Read'];
}

function endpoints(client: OAuthClient): { authorize: string; token: string } {
  if (client.provider === 'google') {
    return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' };
  }
  const directory = encodeURIComponent(client.directory ?? 'common');
  return {
    authorize: `https://login.microsoftonline.com/${directory}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${directory}/oauth2/v2.0/token`,
  };
}

/**
 * Where to send the person to connect, and what to keep until they come back: `state` (compare
 * it, in constant time, with the one they return with) and `verifier` (for exchangeCode). Keep both
 * server-side, bound to the signed-in person's session, for at most ten minutes.
 */
export function beginAuthorization(
  client: OAuthClient,
  options: { writeBack: boolean; loginHint?: string },
): { url: string; state: string; verifier: string } {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: oauthScopes(client.provider, options.writeBack).join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(client.provider === 'google'
      // Only what this connection asks for: never scopes the person granted the app before
      // (include_granted_scopes would add them, so a read-only connection could hold a token
      // that writes events).
      ? { access_type: 'offline', prompt: 'consent' }
      : { response_mode: 'query' }),
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });
  return { url: `${endpoints(client).authorize}?${params}`, state, verifier };
}

/** The tokens the code the person came back with is worth. */
export function exchangeCode(
  client: OAuthClient,
  params: { code: string; verifier: string },
  send: typeof fetch = fetch,
): Promise<OAuthTokens> {
  return tokenRequest(
    client,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: client.redirectUri,
      code_verifier: params.verifier,
    },
    null,
    send,
  );
}

/** Fresh tokens for a refresh token. Microsoft rotates it: keep the one answered. */
export function refreshTokens(client: OAuthClient, refreshToken: string, send: typeof fetch = fetch): Promise<OAuthTokens> {
  return tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken, send);
}

async function tokenRequest(
  client: OAuthClient,
  grant: Record<string, string>,
  previousRefreshToken: string | null,
  send: typeof fetch,
): Promise<OAuthTokens> {
  const response = await send(endpoints(client).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...grant }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new OAuthError(typeof body.error === 'string' ? body.error : 'invalid_response', response.status);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in ?? 3_600);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previousRefreshToken,
    // A minute early, so a token is never used as it expires.
    expiresAt: new Date(Date.now() + Math.max(0, expiresIn - 60) * 1_000),
    scope: typeof body.scope === 'string' ? body.scope : '',
  };
}
