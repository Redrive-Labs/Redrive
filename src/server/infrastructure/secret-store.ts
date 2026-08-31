import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  linkSync,
  unlinkSync,
  writeSync,
  constants as fsConstants,
  type Stats,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export interface SecretStore {
  putPrivateKey(pem: string): string;
  putPrivateKeyForManifestAttempt(attemptId: string, pem: string): string;
  readPrivateKey(reference: string): string;
}

export class SecretStoreError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "SecretStoreError";
    this.retryable = retryable;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPORARY_REFERENCE_PATTERN =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.secret$/;
const SECRET_REFERENCE_PATTERN =
  /^(?:github-app-private-key|github-app-manifest)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pem$/;
const MAX_PRIVATE_KEY_BYTES = 128 * 1024;

interface SecretStoreFilesystem {
  openSync(path: string, flags: number, mode?: number): number;
  writeSync(
    fileDescriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  fstatSync(fileDescriptor: number): Stats;
  fchmodSync(fileDescriptor: number, mode: number): void;
  fsyncSync(fileDescriptor: number): void;
  closeSync(fileDescriptor: number): void;
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  chmodSync(path: string, mode: number): void;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  syncDirectory(path: string): void;
}

export type SecretStoreFilesystemOverrides = Partial<SecretStoreFilesystem>;

function isPosixModeAvailable(stats: Stats): boolean {
  return process.platform !== "win32" && typeof stats.mode === "number";
}

function assertDirectoryMetadata(directory: string, stats: Stats): void {
  if (typeof process.getuid === "function" && typeof stats.uid === "number") {
    if (stats.uid !== process.getuid()) {
      throw new SecretStoreError(
        "The configured secret directory is not owned by the Redrive process user.",
      );
    }
  }
  if (isPosixModeAvailable(stats) && (stats.mode & 0o077) !== 0) {
    throw new SecretStoreError(
      "The configured secret directory permissions are too broad.",
    );
  }
}

function assertNoSymlinkComponents(directory: string): void {
  const resolvedDirectory = path.resolve(directory);
  let current = path.parse(resolvedDirectory).root;
  const relative = path.relative(current, resolvedDirectory);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SecretStoreError("The configured secret directory is not safe.");
    }
  }
}

function assertSafeParentDirectories(directory: string): void {
  const resolvedDirectory = path.resolve(directory);
  const rootDirectory = path.parse(resolvedDirectory).root;
  let current = path.dirname(resolvedDirectory);

  while (current !== rootDirectory) {
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SecretStoreError("The configured secret directory is not safe.");
    }

    // A non-sticky parent writable by another POSIX principal could replace
    // the process-owned secret directory or its components. Sticky directories
    // such as /tmp are allowed; ownership and the final directory's 0700 mode
    // still fence the entry itself.
    if (isPosixModeAvailable(stats) && (stats.mode & 0o022) !== 0) {
      const sticky = (stats.mode & 0o1000) !== 0;
      if (!sticky) {
        throw new SecretStoreError(
          "A parent of the configured secret directory is writable by other users.",
        );
      }
    }
    current = path.dirname(current);
  }
}

function assertSafeDirectory(directory: string): void {
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory === path.parse(resolvedDirectory).root) {
    throw new SecretStoreError("The configured secret directory is not safe.");
  }

  try {
    // Node does not provide a portable openat/dirfd anchor. These checks protect
    // the process-owned directory and fail closed on observable path changes;
    // a same-UID attacker remains outside this abstraction's threat model.
    assertNoSymlinkComponents(resolvedDirectory);
    assertSafeParentDirectories(resolvedDirectory);
    try {
      lstatSync(resolvedDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
    }
    assertNoSymlinkComponents(resolvedDirectory);
    assertSafeParentDirectories(resolvedDirectory);
    let stats = lstatSync(resolvedDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SecretStoreError("The configured secret directory is not safe.");
    }

    if (isPosixModeAvailable(stats) && (stats.mode & 0o077) !== 0) {
      // On POSIX, tightening an existing directory is required rather than
      // best-effort. Non-POSIX platforms do not expose these mode semantics.
      chmodSync(resolvedDirectory, 0o700);
      stats = lstatSync(resolvedDirectory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new SecretStoreError("The configured secret directory is not safe.");
      }
    }
    assertDirectoryMetadata(resolvedDirectory, stats);
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw new SecretStoreError("The configured secret directory is not safe.");
  }
}

function assertSafeReference(reference: string): string {
  if (
    typeof reference !== "string" ||
    !SECRET_REFERENCE_PATTERN.test(reference) ||
    path.basename(reference) !== reference
  ) {
    throw new SecretStoreError("The secret reference is invalid.");
  }
  return reference;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (typeof left.dev !== "number" || typeof right.dev !== "number") return true;
  if (typeof left.ino !== "number" || typeof right.ino !== "number") return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularFileMetadata(stats: Stats): void {
  if (typeof process.getuid === "function" && typeof stats.uid === "number") {
    if (stats.uid !== process.getuid()) {
      throw new SecretStoreError(
        "The private key file is not owned by the Redrive process user.",
      );
    }
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SecretStoreError("The private key file is not a regular file.");
  }
  if (isPosixModeAvailable(stats) && (stats.mode & 0o077) !== 0) {
    throw new SecretStoreError("The private key file permissions are too broad.");
  }
}

function assertRegularFileMode(stats: Stats): void {
  assertRegularFileMetadata(stats);
  if (typeof stats.nlink === "number" && stats.nlink !== 1) {
    throw new SecretStoreError("The private key file has an unexpected link count.");
  }
}

function assertRecoverableFileMetadata(stats: Stats): void {
  assertRegularFileMetadata(stats);
  if (
    typeof process.getuid === "function" &&
    (typeof stats.uid !== "number" || stats.uid !== process.getuid())
  ) {
    throw new SecretStoreError(
      "The private key file ownership could not be verified.",
    );
  }
  if (
    process.platform !== "win32" &&
    (typeof stats.mode !== "number" || (stats.mode & 0o777) !== 0o600)
  ) {
    throw new SecretStoreError(
      "The private key file does not have the required private mode.",
    );
  }
}

function hasRequiredFileIdentity(stats: Stats): boolean {
  return (
    typeof stats.dev === "number" &&
    Number.isFinite(stats.dev) &&
    typeof stats.ino === "number" &&
    Number.isFinite(stats.ino)
  );
}

function sameRequiredFileIdentity(left: Stats, right: Stats): boolean {
  return hasRequiredFileIdentity(left) && hasRequiredFileIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    process.platform !== "win32" &&
    (code === "EINVAL" ||
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "ENOSYS")
  );
}

function syncDirectoryWithNodeFs(directory: string): void {
  // Windows does not support opening a directory for fsync through this API.
  if (process.platform === "win32") return;

  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    fsyncSync(fileDescriptor);
  } catch (error) {
    // EINVAL/ENOTSUP are treated as unsupported only after the directory was
    // opened successfully. An error while opening the path is not a harmless
    // fsync capability limitation and must fail closed.
    if (fileDescriptor === undefined || !isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

const defaultFilesystem: SecretStoreFilesystem = {
  openSync,
  writeSync: (fileDescriptor, buffer, offset, length, position) =>
    writeSync(fileDescriptor, buffer, offset, length, position),
  fstatSync,
  fchmodSync,
  fsyncSync,
  closeSync,
  lstatSync,
  readdirSync,
  chmodSync,
  linkSync,
  unlinkSync,
  syncDirectory: syncDirectoryWithNodeFs,
};

export function manifestPrivateKeyReference(attemptId: string): string {
  if (typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId)) {
    throw new SecretStoreError("The manifest attempt identifier is invalid.");
  }
  return `github-app-manifest-${attemptId}.pem`;
}

export class FilesystemSecretStore implements SecretStore {
  readonly directory: string;
  private readonly filesystem: SecretStoreFilesystem;

  constructor(
    directory: string,
    filesystemOverrides: SecretStoreFilesystemOverrides = {},
  ) {
    if (typeof directory !== "string" || directory.trim().length === 0) {
      throw new SecretStoreError("A secret directory is required.");
    }
    this.directory = path.resolve(directory);
    this.filesystem = { ...defaultFilesystem, ...filesystemOverrides };
    assertSafeDirectory(this.directory);
  }

  private readPrivateKeyBytesAtPath(
    filePath: string,
    ensureDurable = false,
    retryableOnFailure = false,
  ): Buffer {
    let initialStats: Stats;
    try {
      initialStats = this.filesystem.lstatSync(filePath);
    } catch (error) {
      // A missing deterministic object is key loss, not an operation that a
      // retry can repair. Other filesystem failures may be transient.
      throw new SecretStoreError(
        "The referenced private key is unavailable.",
        retryableOnFailure && (error as NodeJS.ErrnoException).code !== "ENOENT",
      );
    }
    assertRegularFileMode(initialStats);
    if (initialStats.size > MAX_PRIVATE_KEY_BYTES) {
      throw new SecretStoreError("The referenced private key is too large.");
    }

    let fileDescriptor: number | undefined;
    let operationFailed = false;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      fileDescriptor = this.filesystem.openSync(
        filePath,
        fsConstants.O_RDONLY | noFollow,
      );
      const openedStats = this.filesystem.fstatSync(fileDescriptor);
      assertRegularFileMode(openedStats);
      if (!sameFileIdentity(initialStats, openedStats)) {
        throw new SecretStoreError("The referenced private key changed unexpectedly.");
      }
      const value = readFileSync(/* turbopackIgnore: true */ fileDescriptor);
      const finalStats = this.filesystem.fstatSync(fileDescriptor);
      assertRegularFileMode(finalStats);
      if (
        !sameFileIdentity(openedStats, finalStats) ||
        finalStats.size > MAX_PRIVATE_KEY_BYTES ||
        finalStats.size !== value.byteLength
      ) {
        throw new SecretStoreError("The referenced private key changed unexpectedly.");
      }
      if (ensureDurable) {
        this.filesystem.fsyncSync(fileDescriptor);
        this.filesystem.syncDirectory(this.directory);
      }
      return value;
    } catch (error) {
      operationFailed = true;
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(
        "The referenced private key is unavailable.",
        retryableOnFailure && (error as NodeJS.ErrnoException).code !== "ENOENT",
      );
    } finally {
      if (fileDescriptor !== undefined) {
        const descriptor = fileDescriptor;
        fileDescriptor = undefined;
        try {
          this.filesystem.closeSync(descriptor);
        } catch (error) {
          // Never let a close failure mask a deterministic validation error.
          if (!operationFailed) {
            if (!(error instanceof SecretStoreError)) {
              throw new SecretStoreError(
                "The referenced private key could not be closed safely.",
                retryableOnFailure,
              );
            }
            throw error;
          }
        }
      }
    }
  }

  private putPrivateKeyAtReference(reference: string, pem: string): string {
    assertSafeReference(reference);
    if (typeof pem !== "string" || pem.length === 0) {
      throw new SecretStoreError("A private key is required.");
    }

    const bytes = Buffer.from(pem, "utf8");
    if (bytes.byteLength > MAX_PRIVATE_KEY_BYTES) {
      throw new SecretStoreError("The private key is too large.");
    }

    assertSafeDirectory(this.directory);
    const temporaryReference = `.tmp-${randomUUID()}.secret`;
    const temporaryPath = path.join(this.directory, temporaryReference);
    const finalPath = path.join(this.directory, reference);
    let fileDescriptor: number | undefined;
    let publishedByUs = false;
    let succeeded = false;
    let createdTemporary = false;
    let temporaryLinkRemoved = false;
    let expectedIdentity: Stats | undefined;

    try {
      try {
        const noFollow = fsConstants.O_NOFOLLOW ?? 0;
        fileDescriptor = this.filesystem.openSync(
          temporaryPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            noFollow,
          0o600,
        );
        createdTemporary = true;
        expectedIdentity = this.filesystem.fstatSync(fileDescriptor);
        assertRegularFileMode(expectedIdentity);
        const pathIdentity = this.filesystem.lstatSync(temporaryPath);
        assertRegularFileMode(pathIdentity);
        if (!sameFileIdentity(expectedIdentity, pathIdentity)) {
          throw new SecretStoreError("The temporary private key path changed unexpectedly.");
        }

        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = this.filesystem.writeSync(
            fileDescriptor,
            bytes,
            offset,
            bytes.byteLength - offset,
            null,
          );
          if (!Number.isInteger(written) || written <= 0) {
            throw new SecretStoreError("The private key write did not make progress.");
          }
          if (written > bytes.byteLength - offset) {
            throw new SecretStoreError("The private key write exceeded its buffer.");
          }
          offset += written;
        }

        this.filesystem.fchmodSync(fileDescriptor, 0o600);
        const writtenStats = this.filesystem.fstatSync(fileDescriptor);
        assertRegularFileMode(writtenStats);
        if (
          expectedIdentity === undefined ||
          !sameFileIdentity(expectedIdentity, writtenStats) ||
          writtenStats.size !== bytes.byteLength
        ) {
          throw new SecretStoreError("The temporary private key changed unexpectedly.");
        }
        // An arbitrary file fsync failure is not an unsupported-platform
        // success; it fails the write before the object can be published.
        this.filesystem.fsyncSync(fileDescriptor);
      } finally {
        if (fileDescriptor !== undefined) {
          const descriptor = fileDescriptor;
          fileDescriptor = undefined;
          this.filesystem.closeSync(descriptor);
        }
      }

      const temporaryStats = this.filesystem.lstatSync(temporaryPath);
      assertRegularFileMode(temporaryStats);
      if (expectedIdentity === undefined || !sameFileIdentity(expectedIdentity, temporaryStats)) {
        throw new SecretStoreError("The temporary private key changed unexpectedly.");
      }
      try {
        // link(2) is an atomic same-filesystem no-replace publication. Unlike
        // rename, it fails with EEXIST and can never clobber the destination.
        this.filesystem.linkSync(temporaryPath, finalPath);
        publishedByUs = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingBytes = this.readPrivateKeyBytesAtPath(finalPath, true);
        if (!existingBytes.equals(bytes)) {
          throw new SecretStoreError("The deterministic private key does not match.");
        }
        // The temporary copy is cleaned up by the finally block. Never touch
        // the already-published deterministic object.
        return reference;
      }

      // Drop the temporary hard link before validating the final object so the
      // existing nlink === 1 security invariant remains in force. A verifier
      // may have already removed this link after publication; that is safe as
      // long as the published final object is still revalidated below.
      try {
        this.filesystem.unlinkSync(temporaryPath);
        temporaryLinkRemoved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // ENOENT leaves the unlink outcome ambiguous to this process. Do not
        // remove the final object in failure cleanup; revalidation below is
        // still required before accepting the publication.
      }
      const finalStats = this.filesystem.lstatSync(finalPath);
      assertRegularFileMode(finalStats);
      if (expectedIdentity === undefined || !sameFileIdentity(expectedIdentity, finalStats)) {
        throw new SecretStoreError("The published private key changed unexpectedly.");
      }
      // A directory fsync is explicit about the small set of known unsupported
      // cases. Unexpected filesystem errors propagate and prevent success.
      this.filesystem.syncDirectory(this.directory);
      succeeded = true;
      return reference;
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError("The private key could not be stored safely.");
    } finally {
      // A failed pre-publication write must not leave attacker-controlled temp
      // material. A failed post-publication operation is removed only after
      // temp-link removal completed and the path still names our object. An
      // ambiguous temp unlink never permits deleting the final object.
      if (!succeeded) {
        try {
          const pathsToClean = publishedByUs && temporaryLinkRemoved
            ? [finalPath, temporaryPath]
            : [temporaryPath];
          for (const pathToClean of pathsToClean) {
            try {
              const stats = this.filesystem.lstatSync(pathToClean);
              if (
                stats.isFile() &&
                !stats.isSymbolicLink() &&
                createdTemporary &&
                (expectedIdentity === undefined ||
                  sameFileIdentity(expectedIdentity, stats))
              ) {
                this.filesystem.unlinkSync(pathToClean);
              }
            } catch {
              // The operation has already failed; cleanup must not mask its error.
            }
          }
        } catch {
          // The operation has already failed; cleanup must not mask its error.
        }
      }
    }
  }

  putPrivateKey(pem: string): string {
    return this.putPrivateKeyAtReference(
      `github-app-private-key-${randomUUID()}.pem`,
      pem,
    );
  }

  putPrivateKeyForManifestAttempt(attemptId: string, pem: string): string {
    return this.putPrivateKeyAtReference(
      manifestPrivateKeyReference(attemptId),
      pem,
    );
  }

  readPrivateKey(reference: string): string {
    assertSafeDirectory(this.directory);
    const safeReference = assertSafeReference(reference);
    const filePath = path.join(this.directory, safeReference);
    return this.readPrivateKeyBytesAtPath(filePath).toString("utf8");
  }

  private revalidateRecoveredPrivateKey(
    finalPath: string,
    expectedIdentity: Stats,
  ): void {
    try {
      let finalStats: Stats;
      try {
        finalStats = this.filesystem.lstatSync(finalPath);
      } catch (error) {
        // ENOENT is a deterministic loss/contradiction. Other failures while
        // checking the already-published object can be retried safely.
        throw new SecretStoreError(
          "The published private key could not be revalidated safely.",
          (error as NodeJS.ErrnoException).code !== "ENOENT",
        );
      }
      assertRecoverableFileMetadata(finalStats);
      if (
        typeof finalStats.nlink !== "number" ||
        finalStats.nlink !== 1 ||
        !sameRequiredFileIdentity(expectedIdentity, finalStats)
      ) {
        throw new SecretStoreError(
          "The published private key changed unexpectedly.",
        );
      }

      let fileDescriptor: number | undefined;
      let validationFailed = false;
      try {
        const noFollow = fsConstants.O_NOFOLLOW ?? 0;
        try {
          fileDescriptor = this.filesystem.openSync(
            finalPath,
            fsConstants.O_RDONLY | noFollow,
          );
        } catch (error) {
          throw new SecretStoreError(
            "The deterministic private key could not be revalidated safely.",
            (error as NodeJS.ErrnoException).code !== "ENOENT",
          );
        }
        let openedStats: Stats;
        try {
          openedStats = this.filesystem.fstatSync(fileDescriptor);
        } catch {
          throw new SecretStoreError(
            "The deterministic private key could not be revalidated safely.",
            true,
          );
        }
        assertRecoverableFileMetadata(openedStats);
        if (
          typeof openedStats.nlink !== "number" ||
          openedStats.nlink !== 1 ||
          !sameRequiredFileIdentity(expectedIdentity, openedStats)
        ) {
          throw new SecretStoreError(
            "The published private key changed unexpectedly.",
          );
        }
      } catch (error) {
        validationFailed = true;
        throw error;
      } finally {
        if (fileDescriptor !== undefined) {
          try {
            this.filesystem.closeSync(fileDescriptor);
          } catch (error) {
            // Never let a close failure mask a deterministic identity or
            // metadata contradiction found while validating the inode.
            if (!validationFailed) {
              if (error instanceof SecretStoreError) throw error;
              throw new SecretStoreError(
                "The deterministic private key could not be closed safely.",
                true,
              );
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(
        "The deterministic private key could not be revalidated safely.",
        true,
      );
    }
  }

  // Returns true when a stale temporary link was reconciled. Callers use this
  // to preserve retryability for transient failures in the subsequent durable
  // read, while deterministic identity and metadata contradictions remain
  // fail-closed.
  private recoverStaleTemporaryLink(finalPath: string): boolean {
    let initialStats: Stats;
    try {
      initialStats = this.filesystem.lstatSync(finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new SecretStoreError(
        "The deterministic private key could not be inspected safely.",
        true,
      );
    }
    if (typeof initialStats.nlink !== "number" || initialStats.nlink <= 1) {
      return false;
    }

    try {
      assertRecoverableFileMetadata(initialStats);
      if (initialStats.nlink !== 2) {
        throw new SecretStoreError(
          "The deterministic private key has unexplained links.",
        );
      }
      if (!hasRequiredFileIdentity(initialStats)) {
        throw new SecretStoreError(
          "The deterministic private key identity could not be verified.",
        );
      }

      const temporaryReferences = this.filesystem
        .readdirSync(this.directory)
        .filter((entry) => TEMPORARY_REFERENCE_PATTERN.test(entry));
      const matchingTemporaryPaths: string[] = [];
      let temporaryPathDisappeared = false;
      for (const temporaryReference of temporaryReferences) {
        const temporaryPath = path.join(this.directory, temporaryReference);
        if (
          path.dirname(path.resolve(temporaryPath)) !== this.directory ||
          path.basename(temporaryPath) !== temporaryReference
        ) {
          throw new SecretStoreError("The temporary private key path is not safe.");
        }

        let temporaryStats: Stats;
        try {
          temporaryStats = this.filesystem.lstatSync(temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            temporaryPathDisappeared = true;
            continue;
          }
          throw error;
        }
        if (!hasRequiredFileIdentity(temporaryStats)) {
          throw new SecretStoreError(
            "The temporary private key identity could not be verified.",
          );
        }
        if (!sameRequiredFileIdentity(initialStats, temporaryStats)) continue;

        assertRecoverableFileMetadata(temporaryStats);
        if (
          typeof temporaryStats.nlink !== "number" ||
          temporaryStats.nlink !== 2
        ) {
          throw new SecretStoreError(
            "The temporary private key has an unexpected link count.",
          );
        }
        matchingTemporaryPaths.push(temporaryPath);
      }

      if (matchingTemporaryPaths.length !== 1) {
        if (temporaryPathDisappeared) {
          // A concurrent reconciler may have removed the matching path between
          // readdir and lstat. The final inode must prove that it won the race.
          this.revalidateRecoveredPrivateKey(finalPath, initialStats);
          this.filesystem.syncDirectory(this.directory);
          this.revalidateRecoveredPrivateKey(finalPath, initialStats);
          return true;
        }
        throw new SecretStoreError(
          "The deterministic private key has no unique stale temporary link.",
        );
      }

      try {
        this.filesystem.unlinkSync(matchingTemporaryPaths[0]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Another reconciler won the unlink race. Re-stat and revalidate the
        // final inode before accepting the race as idempotent.
        this.revalidateRecoveredPrivateKey(finalPath, initialStats);
      }
      // A directory sync failure after unlink leaves a complete checkpoint and
      // a safe retry path. Do not turn that uncertainty into key loss.
      this.filesystem.syncDirectory(this.directory);
      this.revalidateRecoveredPrivateKey(finalPath, initialStats);
      return true;
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      // Every raw filesystem error is an operation uncertainty. Security and
      // identity contradictions are raised as SecretStoreError above and stay
      // deterministic; operational errors remain retryable even before unlink.
      throw new SecretStoreError(
        "The deterministic private key could not be recovered safely.",
        true,
      );
    }
  }

  verifyPrivateKeyForManifestAttempt(
    attemptId: string,
    expectedSha256: string,
  ): string {
    assertSafeDirectory(this.directory);
    const reference = manifestPrivateKeyReference(attemptId);
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new SecretStoreError("The private key digest is invalid.");
    }
    const finalPath = path.join(
      this.directory,
      assertSafeReference(reference),
    );
    this.recoverStaleTemporaryLink(finalPath);
    // Every call is reconciliation against a complete checkpoint. Keep raw
    // non-ENOENT read/durability failures retryable even after an earlier call
    // removed the stale link; deterministic metadata and digest failures remain
    // SecretStoreError instances with retryable=false.
    const bytes = this.readPrivateKeyBytesAtPath(finalPath, true, true);
    const actual = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(expectedSha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new SecretStoreError("The deterministic private key does not match.");
    }
    return reference;
  }
}
