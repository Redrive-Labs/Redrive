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
  renameSync,
  unlinkSync,
  writeSync,
  constants as fsConstants,
  type Stats,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface SecretStore {
  putPrivateKey(pem: string): string;
  putPrivateKeyForManifestAttempt(attemptId: string, pem: string): string;
  readPrivateKey(reference: string): string;
}

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  chmodSync(path: string, mode: number): void;
  renameSync(oldPath: string, newPath: string): void;
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

function assertRegularFileMode(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SecretStoreError("The private key file is not a regular file.");
  }
  if (typeof stats.nlink === "number" && stats.nlink !== 1) {
    throw new SecretStoreError("The private key file has an unexpected link count.");
  }
  if (isPosixModeAvailable(stats) && (stats.mode & 0o077) !== 0) {
    throw new SecretStoreError("The private key file permissions are too broad.");
  }
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
  chmodSync,
  renameSync,
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
    let renamed = false;
    let succeeded = false;
    let createdTemporary = false;
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
        this.filesystem.lstatSync(finalPath);
        throw new SecretStoreError("The private key reference already exists.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.filesystem.renameSync(temporaryPath, finalPath);
      renamed = true;
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
      // A failed pre-rename write must not leave attacker-controlled temp
      // material. A failed post-rename operation is removed only when the path
      // still names the object we just published. A successful write is never
      // cleaned up here.
      if (!succeeded) {
        try {
          const pathToClean = renamed ? finalPath : temporaryPath;
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

    let initialStats: Stats;
    try {
      initialStats = this.filesystem.lstatSync(filePath);
    } catch {
      throw new SecretStoreError("The referenced private key is unavailable.");
    }
    assertRegularFileMode(initialStats);
    if (initialStats.size > MAX_PRIVATE_KEY_BYTES) {
      throw new SecretStoreError("The referenced private key is too large.");
    }

    let fileDescriptor: number | undefined;
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
      const value = readFileSync(
        /* turbopackIgnore: true */ fileDescriptor,
        { encoding: "utf8" },
      );
      const finalStats = this.filesystem.fstatSync(fileDescriptor);
      assertRegularFileMode(finalStats);
      if (
        !sameFileIdentity(openedStats, finalStats) ||
        finalStats.size !== Buffer.byteLength(value, "utf8")
      ) {
        throw new SecretStoreError("The referenced private key changed unexpectedly.");
      }
      return value;
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError("The referenced private key is unavailable.");
    } finally {
      if (fileDescriptor !== undefined) {
        const descriptor = fileDescriptor;
        fileDescriptor = undefined;
        try {
          this.filesystem.closeSync(descriptor);
        } catch (error) {
          if (!(error instanceof SecretStoreError)) {
            throw new SecretStoreError("The referenced private key could not be closed safely.");
          }
          throw error;
        }
      }
    }
  }
}
