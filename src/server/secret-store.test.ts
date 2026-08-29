import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  readlinkSync,
  statSync,
  lstatSync as nativeLstatSync,
  symlinkSync,
  readdirSync,
  rmSync,
  linkSync as nativeLinkSync,
  unlinkSync as nativeUnlinkSync,
  writeSync as nativeWriteSync,
  openSync as nativeOpenSync,
  closeSync as nativeCloseSync,
  renameSync as nativeRenameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/database";
import { getDefaultSecretDirectory } from "@/server/config";
import { FilesystemSecretStore, SecretStoreError } from "@/server/secret-store";

const PEM = "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\n";

describe("filesystem GitHub secret store", () => {
  const directories: string[] = [];

  it("uses the process-home default outside a writable repository .local directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(root);
    const repositoryLocal = path.join(root, "repository", ".local");
    mkdirSync(repositoryLocal, { recursive: true, mode: 0o775 });
    const home = path.join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(repositoryLocal, 0o775);
      chmodSync(home, 0o700);
    }

    const secretDirectory = getDefaultSecretDirectory(home);
    const store = new FilesystemSecretStore(secretDirectory);
    const reference = store.putPrivateKey(PEM);

    expect(secretDirectory).toBe(path.join(home, ".redrive", "secrets"));
    expect(path.relative(repositoryLocal, secretDirectory)).toMatch(/^\.\.[\\/]/);
    if (process.platform !== "win32") {
      expect(statSync(path.join(home, ".redrive")).mode & 0o777).toBe(0o700);
      expect(statSync(secretDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(secretDirectory, reference)).mode & 0o777).toBe(0o600);
    }
    expect(store.readPrivateKey(reference)).toBe(PEM);
  });
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("writes generated private-key files atomically with private modes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const reference = store.putPrivateKey(PEM);

    expect(reference).toMatch(/^github-app-private-key-[0-9a-f-]+\.pem$/);
    expect(readdirSync(secretDirectory)).toEqual([reference]);
    expect(store.readPrivateKey(reference)).toBe(PEM);
    expect(statSync(secretDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(secretDirectory, reference)).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(secretDirectory, reference), "utf8")).toBe(PEM);
    expect(statSync(path.join(secretDirectory, reference)).nlink).toBe(1);
  });

  it("survives a verifier removing the temp link before publisher cleanup", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let publisherCleanup = true;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (publisherCleanup && path.basename(filePath).startsWith(".tmp-")) {
          publisherCleanup = false;
          nativeUnlinkSync(filePath);
          const error = new Error("verifier removed temp link") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        nativeUnlinkSync(filePath);
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);

    expect(reference).toBe(`github-app-manifest-${attemptId}.pem`);
    expect(readFileSync(finalPath, "utf8")).toBe(PEM);
    expect(readdirSync(secretDirectory)).toEqual([reference]);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("treats a concurrent stale-link ENOENT as idempotent after final revalidation", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let staleCleanup = false;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (staleCleanup && path.basename(filePath).startsWith(".tmp-")) {
          nativeUnlinkSync(filePath);
          const error = new Error("concurrent cleanup") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        nativeUnlinkSync(filePath);
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const temporaryPath = path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000006.secret");
    nativeLinkSync(path.join(secretDirectory, reference), temporaryPath);
    staleCleanup = true;
    const digest = createHash("sha256").update(PEM).digest("hex");

    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(statSync(path.join(secretDirectory, reference)).nlink).toBe(1);
  });



  it("treats a temp path disappearing during reconciliation scan as idempotent", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let scanTempPath = "";
    let armed = false;
    const store = new FilesystemSecretStore(secretDirectory, {
      lstatSync: (filePath) => {
        if (armed && filePath === scanTempPath) {
          nativeUnlinkSync(filePath);
          const error = new Error("concurrent cleanup") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return nativeLstatSync(filePath);
      },
      syncDirectory: () => {},
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    scanTempPath = path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000010.secret");
    nativeLinkSync(path.join(secretDirectory, reference), scanTempPath);
    armed = true;
    const digest = createHash("sha256").update(PEM).digest("hex");
    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(statSync(path.join(secretDirectory, reference)).nlink).toBe(1);
  });

  it.each(["missing", "different"] as const)("fails closed when an ENOENT race leaves a %s final inode", (outcome) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let finalPath = "";
    let armed = false;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (armed && path.basename(filePath).startsWith(".tmp-")) {
          nativeUnlinkSync(filePath);
          if (outcome === "missing") nativeUnlinkSync(finalPath);
          else {
            const replacement = `${finalPath}.replacement`;
            writeFileSync(replacement, PEM, { mode: 0o600 });
            nativeUnlinkSync(finalPath);
            nativeRenameSync(replacement, finalPath);
          }
          const error = new Error("concurrent cleanup") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        nativeUnlinkSync(filePath);
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    finalPath = path.join(secretDirectory, reference);
    nativeLinkSync(finalPath, path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000008.secret"));
    armed = true;
    const digest = createHash("sha256").update(PEM).digest("hex");
    let caught: unknown;
    try { store.verifyPrivateKeyForManifestAttempt(attemptId, digest); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ retryable: false });
  });

  it.each(["stat", "open", "close"] as const)("keeps post-unlink %s revalidation uncertainty retryable", (stage) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let finalPath = "";
    let armed = false;
    let finalStatsCalls = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (armed && path.basename(filePath).startsWith(".tmp-")) {
          nativeUnlinkSync(filePath);
          const error = new Error("concurrent cleanup") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        nativeUnlinkSync(filePath);
      },
      lstatSync: (filePath) => {
        if (armed && stage === "stat" && filePath === finalPath && ++finalStatsCalls === 2) {
          throw new Error("transient stat failure");
        }
        return nativeLstatSync(filePath);
      },
      openSync: (filePath, flags, mode) => {
        if (armed && stage === "open" && filePath === finalPath) throw new Error("transient open failure");
        return nativeOpenSync(filePath, flags, mode);
      },
      closeSync: (fileDescriptor) => {
        if (armed && stage === "close") throw new Error("transient close failure");
        nativeCloseSync(fileDescriptor);
      },
      syncDirectory: () => {},
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    finalPath = path.join(secretDirectory, reference);
    nativeLinkSync(finalPath, path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000009.secret"));
    armed = true;
    const digest = createHash("sha256").update(PEM).digest("hex");
    let caught: unknown;
    try { store.verifyPrivateKeyForManifestAttempt(attemptId, digest); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ retryable: true });
  });


  it("keeps a later reconciliation retryable after a prior unlink failure", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let syncs = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      syncDirectory: () => {
        syncs += 1;
        if (syncs === 2) throw new Error("transient directory fsync failure");
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    nativeLinkSync(
      path.join(secretDirectory, reference),
      path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000011.secret"),
    );
    const digest = createHash("sha256").update(PEM).digest("hex");
    let firstError: unknown;
    try { store.verifyPrivateKeyForManifestAttempt(attemptId, digest); } catch (error) { firstError = error; }
    expect(firstError).toMatchObject({ retryable: true });
    expect(statSync(path.join(secretDirectory, reference)).nlink).toBe(1);
    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
  });

  it("keeps post-unlink durability uncertainty retryable", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let syncs = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      syncDirectory: () => {
        syncs += 1;
        if (syncs > 1) throw new Error("transient directory fsync failure");
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    nativeLinkSync(
      path.join(secretDirectory, reference),
      path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000007.secret"),
    );
    const digest = createHash("sha256").update(PEM).digest("hex");

    let caught: unknown;
    try {
      store.verifyPrivateKeyForManifestAttempt(attemptId, digest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ retryable: true });
    expect(statSync(path.join(secretDirectory, reference)).nlink).toBe(1);
  });

  it("keeps the published PEM when temp unlink outcome is ambiguous", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let firstTempUnlink = true;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (firstTempUnlink && path.basename(filePath).startsWith(".tmp-")) {
          firstTempUnlink = false;
          const error = new Error("unlink outcome is unknown") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        nativeUnlinkSync(filePath);
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = `github-app-manifest-${attemptId}.pem`;
    const finalPath = path.join(secretDirectory, reference);

    expect(() => store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toThrow(
      SecretStoreError,
    );
    expect(readFileSync(finalPath, "utf8")).toBe(PEM);
    expect(readdirSync(secretDirectory)).toEqual([reference]);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("recovers a deterministic PEM left with its temp hard link after publication", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let crashed = true;
    const store = new FilesystemSecretStore(secretDirectory, {
      unlinkSync: (filePath) => {
        if (crashed) throw new Error("simulated crash");
        nativeUnlinkSync(filePath);
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = `github-app-manifest-${attemptId}.pem`;
    expect(() => store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toThrow(
      SecretStoreError,
    );
    const finalPath = path.join(secretDirectory, reference);
    const temporaryReferences = readdirSync(secretDirectory).filter((entry) =>
      entry.startsWith(".tmp-"),
    );

    expect(temporaryReferences).toHaveLength(1);
    expect(statSync(finalPath).nlink).toBe(2);

    crashed = false;
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");
    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(readdirSync(secretDirectory)).toEqual([reference]);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("fsyncs the secret directory after stale temp-link cleanup", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const syncSnapshots: string[][] = [];
    const store = new FilesystemSecretStore(secretDirectory, {
      syncDirectory: (directoryPath) => {
        syncSnapshots.push(readdirSync(directoryPath));
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const temporaryPath = path.join(
      secretDirectory,
      ".tmp-00000000-0000-0000-0000-000000000001.secret",
    );
    nativeLinkSync(finalPath, temporaryPath);
    const syncsBeforeRecovery = syncSnapshots.length;
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(syncSnapshots.slice(syncsBeforeRecovery)).toEqual([[reference], [reference]]);
  });

  it("does not remove an unrelated hard link and fails closed", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const unrelatedPath = path.join(secretDirectory, "unrelated-hard-link");
    nativeLinkSync(finalPath, unrelatedPath);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    expect(readdirSync(secretDirectory)).toContain("unrelated-hard-link");
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("fails closed when a temp-named file has the wrong inode", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const unrelatedPath = path.join(secretDirectory, "unrelated-hard-link");
    const wrongTemporaryPath = path.join(
      secretDirectory,
      ".tmp-00000000-0000-0000-0000-000000000002.secret",
    );
    nativeLinkSync(finalPath, unrelatedPath);
    writeFileSync(wrongTemporaryPath, PEM, { mode: 0o600 });
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    expect(readdirSync(secretDirectory)).toEqual(
      expect.arrayContaining([reference, "unrelated-hard-link", path.basename(wrongTemporaryPath)]),
    );
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("fails closed when a matching temp link has unsafe metadata", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const matchingTemporaryPath = path.join(
      secretDirectory,
      ".tmp-00000000-0000-0000-0000-000000000005.secret",
    );
    const store = new FilesystemSecretStore(secretDirectory, {
      lstatSync: (filePath) => {
        const stats = nativeLstatSync(filePath);
        if (filePath === matchingTemporaryPath && process.platform !== "win32") {
          stats.mode |= 0o004;
        }
        return stats;
      },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    nativeLinkSync(finalPath, matchingTemporaryPath);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    expect(readdirSync(secretDirectory)).toEqual(
      expect.arrayContaining([reference, path.basename(matchingTemporaryPath)]),
    );
    expect(statSync(finalPath).nlink).toBe(2);
  });

  it("fails closed when multiple hard links explain the final file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const extraPaths = [
      path.join(secretDirectory, "extra-hard-link-one"),
      path.join(secretDirectory, "extra-hard-link-two"),
    ];
    nativeLinkSync(finalPath, extraPaths[0]);
    nativeLinkSync(finalPath, extraPaths[1]);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    expect(readdirSync(secretDirectory)).toEqual(
      expect.arrayContaining([reference, ...extraPaths.map((filePath) => path.basename(filePath))]),
    );
    expect(statSync(finalPath).nlink).toBe(3);
  });

  it("fails closed for multiple matching temp links", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const temporaryPaths = [
      path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000003.secret"),
      path.join(secretDirectory, ".tmp-00000000-0000-0000-0000-000000000004.secret"),
    ];
    nativeLinkSync(finalPath, temporaryPaths[0]);
    nativeLinkSync(finalPath, temporaryPaths[1]);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    expect(readdirSync(secretDirectory)).toEqual(
      expect.arrayContaining([reference, ...temporaryPaths.map((filePath) => path.basename(filePath))]),
    );
    expect(statSync(finalPath).nlink).toBe(3);
  });

  it("ignores an unrelated temp file when one matching hard link exists", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const finalPath = path.join(secretDirectory, reference);
    const matchingTemporaryPath = path.join(
      secretDirectory,
      ".tmp-00000000-0000-0000-0000-000000000003.secret",
    );
    const unrelatedTemporaryPath = path.join(
      secretDirectory,
      ".tmp-00000000-0000-0000-0000-000000000004.secret",
    );
    nativeLinkSync(finalPath, matchingTemporaryPath);
    writeFileSync(unrelatedTemporaryPath, PEM, { mode: 0o600 });
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(readdirSync(secretDirectory)).toEqual([
      path.basename(unrelatedTemporaryPath),
      reference,
    ]);
    expect(statSync(finalPath).nlink).toBe(1);
  });

  it("rejects traversal and symlink references", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    expect(() => store.readPrivateKey("../private.pem")).toThrow(SecretStoreError);
    const outside = path.join(directory, "outside.pem");
    writeFileSync(outside, PEM, { mode: 0o600 });
    const symlink = path.join(secretDirectory, "github-app-private-key-00000000-0000-0000-0000-000000000000.pem");
    symlinkSync(outside, symlink);
    expect(() => store.readPrivateKey(path.basename(symlink))).toThrow(SecretStoreError);
    expect(readlinkSync(symlink)).toBe(outside);
  });

  it("rejects a secret directory under a non-sticky writable parent", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const unsafeParent = path.join(directory, "unsafe-parent");
    mkdirSync(unsafeParent, { mode: 0o777 });
    // Respecting umask is not enough for this boundary test.
    chmodSync(unsafeParent, 0o777);
    expect(() => new FilesystemSecretStore(path.join(unsafeParent, "secrets"))).toThrow(
      SecretStoreError,
    );
  });

  it("rejects a secret directory whose parent is a symlink", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const outside = path.join(directory, "outside");
    const parentLink = path.join(directory, "linked-parent");
    const secretDirectory = path.join(parentLink, "secrets");
    // The target is a real directory, but the configured path must not cross a
    // symlinked parent while writing private key material.
    mkdirSync(outside);
    symlinkSync(outside, parentLink);
    expect(() => new FilesystemSecretStore(secretDirectory)).toThrow(SecretStoreError);
  });

  it("keeps the PEM out of SQLite and stores only a reference", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const store = new FilesystemSecretStore(path.join(directory, "secrets"));
    const reference = store.putPrivateKey(PEM);
    const database = openDatabase(path.join(directory, "records.sqlite"));
    try {
      database.run("CREATE TABLE secret_probe (private_key_ref TEXT NOT NULL)");
      database.run("INSERT INTO secret_probe VALUES (?)", [reference]);
      expect(database.get<{ private_key_ref: string }>("SELECT private_key_ref FROM secret_probe")?.private_key_ref).toBe(reference);
      expect(JSON.stringify(database.all("SELECT * FROM secret_probe"))).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      database.close();
    }
  });

  it("rejects oversized keys before creating a file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    expect(() => store.putPrivateKey("x".repeat(128 * 1024 + 1))).toThrow(SecretStoreError);
    expect(readdirSync(secretDirectory)).toEqual([]);
  });

  it("completes a PEM when the first write is short", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let writes = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      writeSync: (fileDescriptor, buffer, offset, length, position) => {
        writes += 1;
        const requested = writes === 1 ? Math.max(1, Math.floor(length / 2)) : length;
        return nativeWriteSync(fileDescriptor, buffer, offset, requested, position);
      },
    });

    const reference = store.putPrivateKey(PEM);

    expect(writes).toBeGreaterThan(1);
    expect(readFileSync(path.join(secretDirectory, reference), "utf8")).toBe(PEM);
    expect(store.readPrivateKey(reference)).toBe(PEM);
  });

  it("fails closed and removes the temp file when a write makes no progress", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    let writes = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      writeSync: (fileDescriptor, buffer, offset, length, position) => {
        writes += 1;
        if (writes > 1) return 0;
        return nativeWriteSync(
          fileDescriptor,
          buffer,
          offset,
          Math.max(1, Math.floor(length / 2)),
          position,
        );
      },
    });

    expect(() => store.putPrivateKey(PEM)).toThrow(SecretStoreError);
    expect(readdirSync(secretDirectory)).toEqual([]);
  });

  it("does not publish or retain a temp file after an arbitrary fsync failure", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory, {
      fsyncSync: () => {
        const error = new Error("I/O failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });

    expect(() => store.putPrivateKey(PEM)).toThrow(SecretStoreError);
    expect(readdirSync(secretDirectory)).toEqual([]);
  });

  it("removes a published file when directory durability fails", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory, {
      syncDirectory: () => {
        const error = new Error("directory I/O failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });

    expect(() => store.putPrivateKey(PEM)).toThrow(SecretStoreError);
    expect(readdirSync(secretDirectory)).toEqual([]);
  });

  it("reuses an identical deterministic PEM and rejects a different one without replacement", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const filePath = path.join(secretDirectory, reference);
    const original = readFileSync(filePath);

    expect(store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toBe(reference);
    expect(readFileSync(filePath)).toEqual(original);
    expect(() => store.putPrivateKeyForManifestAttempt(attemptId, `${PEM}changed`)).toThrow(
      SecretStoreError,
    );
    expect(readFileSync(filePath)).toEqual(original);
  });

  it("handles an atomic EEXIST from a concurrent destination without clobbering it", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = `github-app-manifest-${attemptId}.pem`;
    const destination = path.join(secretDirectory, reference);
    const concurrentPem = `${PEM}concurrent`;
    let linkCalls = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      linkSync: (_temporaryPath, finalPath) => {
        linkCalls += 1;
        writeFileSync(finalPath, concurrentPem, { mode: 0o600 });
        const error = new Error("destination appeared") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      },
    });

    expect(() => store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toThrow(
      SecretStoreError,
    );
    expect(linkCalls).toBe(1);
    expect(readFileSync(destination, "utf8")).toBe(concurrentPem);
  });

  it("reuses an identical destination reported by atomic EEXIST", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = `github-app-manifest-${attemptId}.pem`;
    const destination = path.join(secretDirectory, reference);
    let linkCalls = 0;
    const store = new FilesystemSecretStore(secretDirectory, {
      linkSync: (_temporaryPath, finalPath) => {
        linkCalls += 1;
        writeFileSync(finalPath, PEM, { mode: 0o600 });
        const error = new Error("destination appeared") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      },
    });

    expect(store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toBe(reference);
    expect(linkCalls).toBe(1);
    expect(readFileSync(destination, "utf8")).toBe(PEM);
  });

  it("durably syncs reused files and reconciliation verification", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    let fileSyncs = 0;
    let directorySyncs = 0;
    const store = new FilesystemSecretStore(path.join(directory, "secrets"), {
      fsyncSync: () => { fileSyncs += 1; },
      syncDirectory: () => { directorySyncs += 1; },
    });
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");
    const fileSyncsAfterPublish = fileSyncs;
    const directorySyncsAfterPublish = directorySyncs;

    expect(store.putPrivateKeyForManifestAttempt(attemptId, PEM)).toBe(reference);
    expect(fileSyncs).toBe(fileSyncsAfterPublish + 2);
    expect(directorySyncs).toBe(directorySyncsAfterPublish + 1);

    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(fileSyncs).toBe(fileSyncsAfterPublish + 3);
    expect(directorySyncs).toBe(directorySyncsAfterPublish + 2);
  });

  it("verifies a deterministic PEM by digest without returning its contents", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const store = new FilesystemSecretStore(path.join(directory, "secrets"));
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);
    const digest = createHash("sha256").update(Buffer.from(PEM, "utf8")).digest("hex");

    expect(store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toBe(reference);
    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, "0".repeat(64))).toThrow(
      SecretStoreError,
    );
    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, "bad-digest")).toThrow(
      SecretStoreError,
    );
  });

  it("fails closed for missing, oversized, and unsafe reconciliation files", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const secretDirectory = path.join(directory, "secrets");
    const store = new FilesystemSecretStore(secretDirectory);
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const digest = "0".repeat(64);
    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );

    const reference = `github-app-manifest-${attemptId}.pem`;
    const destination = path.join(secretDirectory, reference);
    writeFileSync(destination, "x".repeat(128 * 1024 + 1), { mode: 0o600 });
    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
    rmSync(destination);
    const outside = path.join(directory, "outside.pem");
    writeFileSync(outside, PEM, { mode: 0o600 });
    symlinkSync(outside, destination);
    expect(() => store.verifyPrivateKeyForManifestAttempt(attemptId, digest)).toThrow(
      SecretStoreError,
    );
  });

  it("derives a bounded deterministic manifest reference", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-secret-test-"));
    directories.push(directory);
    const store = new FilesystemSecretStore(path.join(directory, "secrets"));
    const attemptId = "12345678-1234-1234-1234-123456789abc";

    const reference = store.putPrivateKeyForManifestAttempt(attemptId, PEM);

    expect(reference).toBe(`github-app-manifest-${attemptId}.pem`);
    expect(store.readPrivateKey(reference)).toBe(PEM);
    expect(() => store.putPrivateKeyForManifestAttempt("../escape", PEM)).toThrow(SecretStoreError);
  });

});
