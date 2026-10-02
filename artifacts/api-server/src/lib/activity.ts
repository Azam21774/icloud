import { db, activityLogsTable } from "@workspace/db";
import { logger } from "./logger";

export async function recordActivity(
  ownerId: string,
  level: "info" | "warning" | "error",
  event: string,
  message: string,
): Promise<void> {
  try {
    await db.insert(activityLogsTable).values({
      ownerId,
      level,
      event,
      message,
    });
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Activity log entry could not be persisted",
    );
  }
}