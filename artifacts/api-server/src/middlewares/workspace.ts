import type { Request } from "express";

export const PUBLIC_WORKSPACE_OWNER_ID = "public-workspace";

export function getOwnerId(req: Request): string {
  if (!req.authUser) {
    throw new Error("Workspace access requires an authenticated user.");
  }
  return req.authUser.id;
}