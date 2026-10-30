import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
import { systemCredentialsAllowed } from "./consent.js";
import { getCursorAccessTokenFromEnv, getTokenExpiry, refreshCursorToken } from "./oauth.js";
import { isRefreshKnownBad, markRefreshFailed, markRefreshSucceeded } from "./refresh-guard.js";
import { CredentialSource } from "../types/enums.js";

export { CredentialSource };

export interface CursorTokenResult {
  accessToken: string;
  source: CredentialSource;
  /** Present when harvested from a store that also has a refresh token. */
  refreshToken?: string;
}

/** Raw token pair as stored by the Cursor CLI or IDE, before any validation. */
interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
}

/** Windows account that owns this WSL session — never scan sibling profiles. */
export function windowsUsernameFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const profile = env.USERPROFILE?.trim();
  if (profile) {
    const normalized = profile.replace(/\\/g, "/");
    const match = /\/Users\/([^/]+)/i.exec(normalized);
    const fromProfile = match?.[1]?.trim();
    if (
      fromProfile &&
      fromProfile !== "Public" &&
      fromProfile !== "Default" &&
      !fromProfile.startsWith(".")
    ) {
      return fromProfile;
    }
  }
  const username = env.USERNAME?.trim();
  if (username && username !== "Public" && username !== "Default" && !username.startsWith(".")) {
    return username;
  }
  return undefined;
}

function isUsable(token: string | undefined): token is string {
  if (!token) return false;
  try {
    return Date.now() < getTokenExpiry(token);
  } catch {
    return false;
  }
}

/**
 * Cursor CLI/desktop sometimes stores the same session JWT as both access and
 * refresh. `exchange_user_api_key` rejects those with "Invalid User API Key",
 * so treat them as non-refreshable and keep using the still-valid access token.
 */
function isExchangeableRefreshToken(
  refreshToken: string | undefined,
  accessToken?: string,
): refreshToken is string {
  if (!refreshToken) return false;
  if (accessToken && refreshToken === accessToken) return false;
  try {
    const parts = refreshToken.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload: unknown = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as { type?: unknown }).type === "session"
      ) {
        return false;
      }
    }
  } catch {
    // Non-JWT refresh tokens are still eligible for exchange.
  }
  return true;
}

/**
 * Exchange a refresh token, honouring the failure back-off.
 *
 * Returns undefined without touching the network when this exact token failed
 * recently — a stale Cursor CLI entry otherwise costs seconds on every launch.
 */
async function tryRefresh(
  refreshToken: string | undefined,
  accessToken?: string,
): Promise<string | undefined> {
  if (!isExchangeableRefreshToken(refreshToken, accessToken)) return undefined;
  if (isRefreshKnownBad(refreshToken)) return undefined;
  try {
    const refreshed = await refreshCursorToken(refreshToken);
    markRefreshSucceeded(refreshToken);
    return refreshed.access;
  } catch {
    markRefreshFailed(refreshToken);
    return undefined;
  }
}

/** Reads the raw Cursor CLI token pair from the macOS Keychain. */
async function readKeychainTokens(): Promise<StoredTokens> {
  if (platform() !== "darwin") return {};

  // Run both Keychain lookups concurrently — they are independent reads.
  const [accessResult, refreshResult] = await Promise.allSettled([
    execFileAsync(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000 },
    ),
    execFileAsync(
      "security",
      ["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000 },
    ),
  ]);

  const tokens: StoredTokens = {};
  if (accessResult.status === "fulfilled") {
    const raw = accessResult.value.stdout.trim();
    if (raw) tokens.accessToken = raw;
  }
  if (refreshResult.status === "fulfilled") {
    const raw = refreshResult.value.stdout.trim();
    if (raw) tokens.refreshToken = raw;
  }
  return tokens;
}

/**
 * Reads token from macOS Keychain (security CLI).
 * Uses async execFile so Keychain reads don't block the event loop.
 */
export async function getCursorKeychainToken(): Promise<CursorTokenResult | undefined> {
  const { accessToken, refreshToken } = await readKeychainTokens();
  if (isUsable(accessToken)) return { accessToken, source: CredentialSource.CliKeychain };
  const refreshed = await tryRefresh(refreshToken, accessToken);
  return refreshed
    ? { accessToken: refreshed, source: CredentialSource.CliKeychainRefresh, refreshToken }
    : undefined;
}

/**
 * Candidate paths for Cursor CLI / desktop `auth.json`.
 * On Windows this is the CLI credential store (Keychain is macOS-only).
 */
export function cursorCliAuthFilePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  plat: NodeJS.Platform = platform(),
): string[] {
  const paths: string[] = [];

  if (plat === "darwin") {
    paths.push(join(home, "Library/Application Support/Cursor/auth.json"));
  } else if (plat === "win32") {
    if (env.APPDATA) paths.push(join(env.APPDATA, "Cursor/auth.json"));
  } else {
    // Linux uses lowercase `~/.config/cursor` (no capital-C fallback).
    // Prefer the local Linux store before any WSL-mounted Windows auth.json.
    paths.push(join(home, ".config/cursor/auth.json"));
    const wslHost = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || existsSync("/mnt/c/Users"));
    if (wslHost) {
      const windowsUser = windowsUsernameFromEnv(env);
      if (windowsUser) {
        paths.push(join("/mnt/c/Users", windowsUser, "AppData/Roaming/Cursor/auth.json"));
      }
    }
  }

  return paths;
}

function parseAuthFileTokens(raw: string): StoredTokens {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const data = parsed as Record<string, unknown>;
  const accessToken = typeof data.accessToken === "string" ? data.accessToken.trim() : undefined;
  const refreshToken = typeof data.refreshToken === "string" ? data.refreshToken.trim() : undefined;
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/** Reads the raw Cursor CLI token pair from `auth.json` (Windows/Linux/macOS file store). */
function readCliAuthFileTokens(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  plat: NodeJS.Platform = platform(),
): StoredTokens {
  const fallback: StoredTokens = {};
  for (const authPath of cursorCliAuthFilePaths(env, home, plat)) {
    try {
      const tokens = parseAuthFileTokens(readFileSync(authPath, "utf8"));
      if (isUsable(tokens.accessToken)) return tokens;
      if (!fallback.refreshToken && tokens.refreshToken)
        fallback.refreshToken = tokens.refreshToken;
      if (!fallback.accessToken && tokens.accessToken) fallback.accessToken = tokens.accessToken;
    } catch {
      // Missing or unreadable auth file
    }
  }
  return fallback;
}

/**
 * Reads token from Cursor CLI `auth.json` (used on Windows where Keychain is unavailable).
 */
export async function getCursorCliAuthFileToken(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  forceRefresh?: boolean;
}): Promise<CursorTokenResult | undefined> {
  const { accessToken, refreshToken } = readCliAuthFileTokens(
    options?.env ?? process.env,
    options?.home ?? homedir(),
    options?.platform ?? platform(),
  );
  if (!options?.forceRefresh && isUsable(accessToken)) {
    return { accessToken, source: CredentialSource.CliAuthFile, refreshToken };
  }
  const refreshed = await tryRefresh(refreshToken, accessToken);
  if (refreshed) {
    return {
      accessToken: refreshed,
      source: CredentialSource.CliAuthFileRefresh,
      refreshToken,
    };
  }
  // forceRefresh could not rotate — keep a still-valid access token rather than failing open.
  return isUsable(accessToken)
    ? { accessToken, source: CredentialSource.CliAuthFile, refreshToken }
    : undefined;
}

// Cache the DatabaseSync constructor at module level so repeated vscdb lookups
// don't pay the dynamic-import cost each time.
let _databaseSyncCache:
  | (new (
      path: string,
      options?: { readOnly?: boolean },
    ) => { prepare(sql: string): { get(): unknown }; close(): void })
  | null
  | undefined = undefined;

async function getDatabaseSync() {
  if (_databaseSyncCache !== undefined) return _databaseSyncCache ?? undefined;
  try {
    const mod = await import("node:sqlite");
    _databaseSyncCache = mod.DatabaseSync as unknown as typeof _databaseSyncCache;
    return _databaseSyncCache ?? undefined;
  } catch {
    _databaseSyncCache = null;
    return undefined;
  }
}

/** Reads the raw Cursor IDE token pair from state.vscdb. */
async function readVscdbTokens(): Promise<StoredTokens> {
  const DatabaseSyncClass = await getDatabaseSync();
  if (!DatabaseSyncClass) return {};

  const dbPaths: string[] = [];
  const home = homedir();

  if (platform() === "darwin") {
    dbPaths.push(join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
  } else if (platform() === "win32") {
    if (process.env.APPDATA) {
      dbPaths.push(join(process.env.APPDATA, "Cursor/User/globalStorage/state.vscdb"));
    }
  } else {
    // Native Linux has no Cursor IDE state.vscdb; only WSL can reuse the
    // current Windows user's AppData database via /mnt/c.
    const wslHost = Boolean(
      process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || existsSync("/mnt/c/Users"),
    );
    if (wslHost) {
      const windowsUser = windowsUsernameFromEnv(process.env);
      if (windowsUser) {
        dbPaths.push(
          join(
            "/mnt/c/Users",
            windowsUser,
            "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
          ),
        );
      }
    }
  }

  // Prefer the first profile that yields a usable access token; otherwise keep
  // the first refresh token seen so a single expired profile still has a path
  // back to a live session.
  const fallback: StoredTokens = {};
  for (const dbPath of dbPaths) {
    try {
      const db = new DatabaseSyncClass(dbPath, { readOnly: true });
      let accessRow: { value?: string } | undefined;
      let refreshRow: { value?: string } | undefined;
      try {
        accessRow = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
          .get() as { value?: string } | undefined;
        refreshRow = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'")
          .get() as { value?: string } | undefined;
      } finally {
        db.close();
      }

      const accessToken = typeof accessRow?.value === "string" ? accessRow.value.trim() : undefined;
      const refreshToken =
        typeof refreshRow?.value === "string" ? refreshRow.value.trim() : undefined;

      if (isUsable(accessToken)) return { accessToken, refreshToken };
      if (!fallback.refreshToken && refreshToken) fallback.refreshToken = refreshToken;
      if (!fallback.accessToken && accessToken) fallback.accessToken = accessToken;
    } catch {
      // Database missing or unreadable
    }
  }
  return fallback;
}

/**
 * Reads token from Cursor IDE state.vscdb.
 */
export async function getCursorVscdbToken(): Promise<CursorTokenResult | undefined> {
  const { accessToken, refreshToken } = await readVscdbTokens();
  if (isUsable(accessToken)) return { accessToken, source: CredentialSource.IdeVscdb, refreshToken };
  const refreshed = await tryRefresh(refreshToken, accessToken);
  return refreshed
    ? { accessToken: refreshed, source: CredentialSource.IdeVscdbRefresh, refreshToken }
    : undefined;
}

/**
 * System credential resolution cascade (after env / when called directly):
 * 1. CURSOR_ACCESS_TOKEN env var
 * 2. Cursor CLI/desktop `auth.json` (Windows/Linux; optional on macOS)
 * 3. macOS Keychain (Cursor CLI)
 * 4. Cursor IDE state.vscdb
 *
 * System sources are read concurrently and every *local* token is checked
 * before any network exchange is attempted. That ordering matters: a stale CLI
 * keychain entry used to trigger a doomed ~2.6s refresh on the startup path
 * even though the IDE database held a valid token two milliseconds away.
 *
 * Opt out of Keychain/auth.json/vscdb scraping with PI_CURSOR_SYSTEM_CREDENTIALS=0.
 */
export async function resolveSystemCursorAccessToken(options?: {
  forceRefresh?: boolean;
  /** When true, skip auth.json (already tried at higher priority by the caller). */
  skipAuthFile?: boolean;
}): Promise<CursorTokenResult | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken) {
    // Env tokens cannot be refreshed here; still prefer them when present.
    if (!options?.forceRefresh || isUsable(envToken)) {
      return { accessToken: envToken, source: CredentialSource.Env };
    }
  }

  if (!systemCredentialsAllowed()) {
    return undefined;
  }

  const [keychain, authFile, vscdb] = await Promise.all([
    readKeychainTokens(),
    options?.skipAuthFile
      ? Promise.resolve({} as StoredTokens)
      : Promise.resolve(readCliAuthFileTokens()),
    readVscdbTokens(),
  ]);

  // Prefer local Cursor auth.json over Keychain / IDE DB.
  const cached: CursorTokenResult | undefined = isUsable(authFile.accessToken)
    ? { accessToken: authFile.accessToken, source: CredentialSource.CliAuthFile }
    : isUsable(keychain.accessToken)
      ? { accessToken: keychain.accessToken, source: CredentialSource.CliKeychain }
      : isUsable(vscdb.accessToken)
        ? { accessToken: vscdb.accessToken, source: CredentialSource.IdeVscdb }
        : undefined;

  // Fast path: a locally stored token is still valid, so no network at all.
  if (cached && !options?.forceRefresh) return cached;

  // Skip duplicate exchanges when the CLI mirrored the same refresh token into
  // auth.json and/or the IDE database.
  const seenRefresh = new Set<string>();

  if (authFile.refreshToken) {
    seenRefresh.add(authFile.refreshToken);
    const authFileRefreshed = await tryRefresh(authFile.refreshToken, authFile.accessToken);
    if (authFileRefreshed) {
      return {
        accessToken: authFileRefreshed,
        source: CredentialSource.CliAuthFileRefresh,
        refreshToken: authFile.refreshToken,
      };
    }
  }

  if (keychain.refreshToken && !seenRefresh.has(keychain.refreshToken)) {
    seenRefresh.add(keychain.refreshToken);
    const keychainRefreshed = await tryRefresh(keychain.refreshToken, keychain.accessToken);
    if (keychainRefreshed) {
      return {
        accessToken: keychainRefreshed,
        source: CredentialSource.CliKeychainRefresh,
        refreshToken: keychain.refreshToken,
      };
    }
  }

  if (vscdb.refreshToken && !seenRefresh.has(vscdb.refreshToken)) {
    const vscdbRefreshed = await tryRefresh(vscdb.refreshToken, vscdb.accessToken);
    if (vscdbRefreshed) {
      return {
        accessToken: vscdbRefreshed,
        source: CredentialSource.IdeVscdbRefresh,
        refreshToken: vscdb.refreshToken,
      };
    }
  }

  // forceRefresh could not improve on what we already had — keep it rather than
  // reporting "not logged in" for a token that is still valid.
  return cached;
}
