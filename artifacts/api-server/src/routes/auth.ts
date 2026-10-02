import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetAuthStatusResponse,
  LoginBody,
  LoginResponse,
  LogoutResponse,
  SetupAdminBody,
  SetupAdminResponse,
} from "@workspace/api-zod";
import {
  appUsersTable,
  db,
} from "@workspace/db";
import {
  burnPasswordVerification,
  clearLoginAttempts,
  createSession,
  findSessionUser,
  hashPassword,
  isLoginRateLimited,
  isValidUsername,
  normalizeUsername,
  removeCurrentSession,
  verifyPassword,
} from "../lib/auth";
import { clearSessionCookie } from "../lib/auth";
import { PUBLIC_WORKSPACE_OWNER_ID } from "../middlewares/workspace";

const router: IRouter = Router();
const ADMIN_BOOTSTRAP_LOCK_ID = 7219184302501;
const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/auth/status", async (req, res, next) => {
  try {
    const [admin] = await db
      .select({ id: appUsersTable.id })
      .from(appUsersTable)
      .where(eq(appUsersTable.role, "admin"))
      .limit(1);
    const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN ?? "";
    res.json(
      GetAuthStatusResponse.parse({
        setupRequired: !admin,
        setupEnabled: bootstrapToken.length >= MIN_BOOTSTRAP_TOKEN_LENGTH,
        user: await findSessionUser(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success || !isValidUsername(parsed.data.username)) {
      res.status(400).json({ error: "Enter a valid username and password." });
      return;
    }

    const { username, password } = parsed.data;
    if (await isLoginRateLimited(req, username)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const [account] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.normalizedUsername, normalizeUsername(username)))
      .limit(1);
    const passwordMatches = account
      ? await verifyPassword(password, account.passwordHash)
      : (await burnPasswordVerification(password), false);

    if (!account || !passwordMatches) {
      res.status(401).json({ error: "Username or password is incorrect." });
      return;
    }

    await clearLoginAttempts(req, username);
    await db
      .update(appUsersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(appUsersTable.id, account.id));
    await createSession(req, res, account.id);
    res.json(
      LoginResponse.parse({
        user: {
          id: account.id,
          username: account.username,
          role: account.role,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/auth/setup", async (req, res, next) => {
  try {
    const parsed = SetupAdminBody.safeParse(req.body);
    if (!parsed.success || !isValidUsername(parsed.data.username)) {
      res.status(400).json({ error: "Enter valid setup details." });
      return;
    }

    const configuredToken = process.env.ADMIN_BOOTSTRAP_TOKEN ?? "";
    if (configuredToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
      res.status(503).json({ error: "Initial administrator setup is not enabled." });
      return;
    }
    const submittedTokenHash = createHash("sha256")
      .update(parsed.data.bootstrapToken)
      .digest();
    const configuredTokenHash = createHash("sha256")
      .update(configuredToken)
      .digest();
    if (!timingSafeEqual(submittedTokenHash, configuredTokenHash)) {
      res.status(400).json({ error: "The setup token is invalid." });
      return;
    }

    const username = parsed.data.username.trim();
    const normalizedUsername = normalizeUsername(username);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_LOCK_ID})`,
      );
      const [existingAdmin] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(eq(appUsersTable.role, "admin"))
        .limit(1);
      if (existingAdmin) return null;

      const [created] = await tx
        .insert(appUsersTable)
        .values({
          id: PUBLIC_WORKSPACE_OWNER_ID,
          username,
          normalizedUsername,
          passwordHash,
          role: "admin",
          lastLoginAt: new Date(),
        })
        .returning({
          id: appUsersTable.id,
          username: appUsersTable.username,
          role: appUsersTable.role,
        });
      return created;
    });

    if (!user) {
      res.status(409).json({ error: "Initial administrator setup is already complete." });
      return;
    }

    await createSession(req, res, user.id);
    res.status(201).json(
      SetupAdminResponse.parse({
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/auth/logout", async (req, res, next) => {
  try {
    await removeCurrentSession(req);
    clearSessionCookie(req, res);
    res.json(LogoutResponse.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

export default router;