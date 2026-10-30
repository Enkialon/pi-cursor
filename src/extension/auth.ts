/**
 * Extension authentication and startup token resolution.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  getCursorAccessTokenFromEnv,
  getTokenExpiry,
  refreshCursorToken,
  type CursorCredentials,
} from "../auth/oauth.js";
import {
  getCursorCliAuthFileToken,
  resolveSystemCursorAccessToken,
} from "../auth/cli-credentials.js";
import { systemCredentialsAllowed } from "../auth/consent.js";
import { CredentialSource, ProviderConstant } from "../types/enums.js";

export interface ResolvedAccessToken {
  accessToken: string;
  source: CredentialSource;
  refreshToken?: string;
}

const SYSTEM_TOKEN_SOURCES = new Set<CredentialSource>([
  CredentialSource.CliAuthFile,
  CredentialSource.CliAuthFileRefresh,
  CredentialSource.CliKeychain,
  CredentialSource.CliKeychainRefresh,
  CredentialSource.IdeVscdb,
  CredentialSource.IdeVscdbRefresh,
]);

function isUsableAccessToken(token: string): boolean {
  try {
    return Date.now() < getTokenExpiry(token);
  } catch {
    return false;
  }
}

function readPiAuthFile(authPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Missing or unreadable — start a fresh store.
  }
  return {};
}

function piOAuthStillUsable(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const cred = entry as Record<string, unknown>;
  return (
    cred.type === "oauth" &&
    typeof cred.access === "string" &&
    cred.access.length > 0 &&
    typeof cred.expires === "number" &&
    Date.now() < cred.expires
  );
}

/** Best-effort write of a rotated OAuth pair back into Pi's auth.json. */
export function persistRefreshedPiOAuth(credentials: CursorCredentials): void {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const data = readPiAuthFile(authPath);
    const existing = data[ProviderConstant.ProviderId];
    data[ProviderConstant.ProviderId] = {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
      type: "oauth",
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
    };
    writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The process still has a usable access token; next launch may need /login.
  }
}

/**
 * Seed Pi's auth.json from a system Cursor login (CLI auth.json / Keychain / IDE).
 * Pi only treats a provider as "configured" when auth.json has an entry — without
 * this, harvested Cursor credentials still leave the UI asking for `/login cursor`.
 */
export function ensurePiOAuthFromSystemTokens(tokens: {
  accessToken: string;
  refreshToken?: string;
}): void {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const data = readPiAuthFile(authPath);
    if (piOAuthStillUsable(data[ProviderConstant.ProviderId])) return;

    const refresh = tokens.refreshToken?.trim() || tokens.accessToken;
    data[ProviderConstant.ProviderId] = {
      type: "oauth",
      access: tokens.accessToken,
      refresh,
      expires: getTokenExpiry(tokens.accessToken),
    };
    writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort only; streaming can still use the harvested token directly.
  }
}

export async function getStoredCursorOAuthAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<ResolvedAccessToken | undefined> {
  const credential = readStoredCredential(ProviderConstant.ProviderId);
  if (!credential || credential.type !== "oauth") return undefined;

  if (!options?.forceRefresh && credential.access && Date.now() < credential.expires) {
    return { accessToken: credential.access, source: CredentialSource.PiOAuth };
  }

  if (credential.refresh) {
    // Session JWTs stored as refresh cannot be exchanged; keep the access token.
    if (credential.refresh === credential.access) {
      return credential.access && Date.now() < credential.expires
        ? { accessToken: credential.access, source: CredentialSource.PiOAuth, refreshToken: credential.refresh }
        : undefined;
    }
    try {
      const refreshed = await refreshCursorToken(credential.refresh);
      persistRefreshedPiOAuth(refreshed);
      return {
        accessToken: refreshed.access,
        source: CredentialSource.PiOAuthRefresh,
        refreshToken: refreshed.refresh,
      };
    } catch {
      if (credential.access && Date.now() < credential.expires) {
        return {
          accessToken: credential.access,
          source: CredentialSource.PiOAuth,
          refreshToken: credential.refresh,
        };
      }
      return undefined;
    }
  }
  return undefined;
}

export async function getStartupCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<ResolvedAccessToken | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken && (!options?.forceRefresh || isUsableAccessToken(envToken))) {
    return { accessToken: envToken, source: CredentialSource.Env };
  }

  // Local Cursor CLI/desktop auth.json beats Pi OAuth / Keychain / IDE DB so the
  // machine's Cursor login is preferred when present.
  if (systemCredentialsAllowed()) {
    const authFile = await getCursorCliAuthFileToken({ forceRefresh: options?.forceRefresh });
    if (authFile) {
      ensurePiOAuthFromSystemTokens(authFile);
      return authFile;
    }
  }

  const oauth = await getStoredCursorOAuthAccessToken(options);
  if (oauth) return oauth;

  const system = await resolveSystemCursorAccessToken({ ...options, skipAuthFile: true });
  if (system && SYSTEM_TOKEN_SOURCES.has(system.source)) {
    ensurePiOAuthFromSystemTokens(system);
  }
  return system;
}

export function isTokenNearExpiry(token: string, skewMs = 60_000): boolean {
  try {
    return Date.now() >= getTokenExpiry(token) - skewMs;
  } catch {
    return true;
  }
}
