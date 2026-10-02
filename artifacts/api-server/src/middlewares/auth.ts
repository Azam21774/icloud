import type { Request, RequestHandler } from "express";
import {
  findSessionUser,
  type AuthenticatedUser,
} from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const user = await findSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    req.authUser = user;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.authUser) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  if (req.authUser.role !== "admin") {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
};

export function getOptionalUser(req: Request): AuthenticatedUser | null {
  return req.authUser ?? null;
}