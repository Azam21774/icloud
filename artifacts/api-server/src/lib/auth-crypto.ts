import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(Buffer.from(key));
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(password, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export function generateTemporaryPassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, encodedSalt, encodedKey] =
    encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== SCRYPT_N ||
    Number(blockSize) !== SCRYPT_R ||
    Number(parallelism) !== SCRYPT_P ||
    !encodedSalt ||
    !encodedKey
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, "base64url");
  const expectedKey = Buffer.from(encodedKey, "base64url");
  if (salt.length !== 16 || expectedKey.length !== SCRYPT_KEY_LENGTH) {
    return false;
  }

  const actualKey = await derivePasswordKey(password, salt);
  return timingSafeEqual(actualKey, expectedKey);
}

const dummyPasswordHash = hashPassword("not-a-real-account-password");

export async function burnPasswordVerification(password: string): Promise<void> {
  await verifyPassword(password, await dummyPasswordHash);
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return /^[A-Za-z0-9._-]{3,32}$/.test(username);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createAccountId(): string {
  return randomUUID();
}