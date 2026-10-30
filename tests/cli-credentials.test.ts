import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cursorCliAuthFilePaths,
  getCursorCliAuthFileToken,
  windowsUsernameFromEnv,
} from "../src/auth/cli-credentials.js";
import { CredentialSource } from "../src/types/enums.js";

describe("WSL Windows username", () => {
  it("reads the account from USERPROFILE and ignores sibling folders", () => {
    expect(
      windowsUsernameFromEnv({
        USERPROFILE: "C:\\Users\\rahul",
        USERNAME: "rahul",
      }),
    ).toBe("rahul");
    expect(
      windowsUsernameFromEnv({
        USERPROFILE: "/mnt/c/Users/rahul",
        USERNAME: "someone-else",
      }),
    ).toBe("rahul");
  });

  it("skips Public/Default profiles", () => {
    expect(windowsUsernameFromEnv({ USERPROFILE: "C:\\Users\\Public" })).toBeUndefined();
    expect(windowsUsernameFromEnv({ USERNAME: "Default" })).toBeUndefined();
  });
});

describe("Cursor CLI auth.json paths", () => {
  it("resolves the Windows Roaming Cursor auth.json", () => {
    expect(
      cursorCliAuthFilePaths(
        { APPDATA: "C:\\Users\\ygzh\\AppData\\Roaming" },
        "C:\\Users\\ygzh",
        "win32",
      ),
    ).toEqual([join("C:\\Users\\ygzh\\AppData\\Roaming", "Cursor/auth.json")]);
  });

  it("resolves macOS Application Support auth.json", () => {
    expect(cursorCliAuthFilePaths({}, "/Users/rahul", "darwin")).toEqual([
      join("/Users/rahul", "Library/Application Support/Cursor/auth.json"),
    ]);
  });

  it("resolves Linux and current-user WSL Windows auth.json", () => {
    expect(
      cursorCliAuthFilePaths(
        { WSL_DISTRO_NAME: "Ubuntu", USERPROFILE: "C:\\Users\\rahul" },
        "/home/rahul",
        "linux",
      ),
    ).toEqual([
      join("/home/rahul", ".config/cursor/auth.json"),
      join("/mnt/c/Users", "rahul", "AppData/Roaming/Cursor/auth.json"),
    ]);
  });

  it("resolves native Linux auth.json without a capital-C or WSL fallback", () => {
    expect(cursorCliAuthFilePaths({}, "/home/rahul", "linux")).toEqual([
      join("/home/rahul", ".config/cursor/auth.json"),
    ]);
  });
});

describe("Cursor CLI auth.json tokens", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("reads a usable access token from Windows auth.json", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-cursor-auth-json-"));
    const cursorDir = join(tempRoot, "Cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "auth.json"),
      JSON.stringify({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
      }),
      "utf8",
    );

    const resolved = await getCursorCliAuthFileToken({
      env: { APPDATA: tempRoot },
      home: tempRoot,
      platform: "win32",
    });

    expect(resolved).toEqual({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      source: CredentialSource.CliAuthFile,
    });
  });

  it("ignores malformed auth.json files", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-cursor-auth-json-"));
    const cursorDir = join(tempRoot, "Cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "auth.json"), "{not-json", "utf8");

    const resolved = await getCursorCliAuthFileToken({
      env: { APPDATA: tempRoot },
      home: tempRoot,
      platform: "win32",
    });

    expect(resolved).toBeUndefined();
  });
});
