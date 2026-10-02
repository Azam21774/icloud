import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  appSessionsTable,
  appUsersTable,
  authLoginAttemptsTable,
  db,
} from "@workspace/db";
import {
  burnPasswordVerification,
  createAccountId,
  generateTemporaryPassword,
  hashPassword,
  hashSessionToken,
  isValidUsername,
  normalizeUsername,
  verifyPassword,
} from "./auth-crypto";

export {
  burnPasswordVerification,
  createAccountId,
  generateTemporaryPassword,
  hashPassword,
  hashSessionToken,
  isValidUsername,
  normalizeUsername,
  verifyPassword,
} from "./auth-crypto";

export const SESSION_COOKIE_NAME = "event_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_BUCKET_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const LOGIN_BUCKET_RETENTION_MS = 60 * 60 * 1000;

export type AuthRole = "admin" | "user";

export type AuthenticatedUser = {
  id: string;
  username: string;
  role: AuthRole;
};

let lastLoginBucketCleanupAt = 0;

function readSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const entry = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) || null : null;
}

function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: req.secure,
    sameSite: "strict",
    path: "/",
  });
}

export async function createSession(
  req: Request,
  res: Response,
  userId: string,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.delete(appSessionsTable).where(lt(appSessionsTable.expiresAt, now));
  await db.insert(appSessionsTable).values({
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  setSessionCookie(req, res, token);
}

export async function findSessionUser(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  const [row] = await db
    .select({
      id: appUsersTable.id,
      username: appUsersTable.username,
      role: appUsersTable.role,
    })
    .from(appSessionsTable)
    .innerJoin(appUsersTable, eq(appSessionsTable.userId, appUsersTable.id))
    .where(
      and(
        eq(appSessionsTable.tokenHash, hashSessionToken(token)),
        gt(appSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || (row.role !== "admin" && row.role !== "user")) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export async function removeCurrentSession(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (!token) return;
  await db
    .delete(appSessionsTable)
    .where(eq(appSessionsTable.tokenHash, hashSessionToken(token)));
}

function loginBucketHash(req: Request, username: string): string {
  return createHash("sha256")
    .update(`${normalizeUsername(username)}\u0000${req.ip ?? "unknown"}`)
    .digest("hex");
}

export async function isLoginRateLimited(
  req: Request,
  username: string,
): Promise<boolean> {
  const now = new Date();
  if (now.getTime() - lastLoginBucketCleanupAt > LOGIN_BUCKET_CLEANUP_INTERVAL_MS) {
    lastLoginBucketCleanupAt = now.getTime();
    await db
      .delete(authLoginAttemptsTable)
      .where(
        lt(
          authLoginAttemptsTable.windowStartedAt,
          new Date(now.getTime() - LOGIN_BUCKET_RETENTION_MS),
        ),
      );
  }

  const bucketHash = loginBucketHash(req, username);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${bucketHash}))`,
    );
    const [bucket] = await tx
      .select()
      .from(authLoginAttemptsTable)
      .where(eq(authLoginAttemptsTable.bucketHash, bucketHash))
      .limit(1);

    if (bucket?.blockedUntil && bucket.blockedUntil > now) return true;

    if (!bucket || now.getTime() - bucket.windowStartedAt.getTime() >= LOGIN_WINDOW_MS) {
      await tx
        .insert(authLoginAttemptsTable)
        .values({
          bucketHash,
          attempts: 1,
          windowStartedAt: now,
          blockedUntil: null,
        })
        .onConflictDoUpdate({
          target: authLoginAttemptsTable.bucketHash,
          set: {
            attempts: 1,
            windowStartedAt: now,
            blockedUntil: null,
          },
        });
      return false;
    }

    if (bucket.attempts >= LOGIN_ATTEMPT_LIMIT) {
      await tx
        .update(authLoginAttemptsTable)
        .set({ blockedUntil: new Date(now.getTime() + LOGIN_LOCKOUT_MS) })
        .where(eq(authLoginAttemptsTable.bucketHash, bucketHash));
      return true;
    }

    await tx
      .update(authLoginAttemptsTable)
      .set({ attempts: bucket.attempts + 1 })
      .where(eq(authLoginAttemptsTable.bucketHash, bucketHash));
    return false;
  });
}

export async function clearLoginAttempts(
  req: Request,
  username: string,
): Promise<void> {
  await db
    .delete(authLoginAttemptsTable)
    .where(eq(authLoginAttemptsTable.bucketHash, loginBucketHash(req, username)));
}
