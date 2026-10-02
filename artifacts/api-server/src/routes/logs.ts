import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { ListLogsResponse } from "@workspace/api-zod";
import { activityLogsTable, db } from "@workspace/db";
import { getOwnerId } from "../middlewares/workspace";

const router: IRouter = Router();

router.get("/logs", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(activityLogsTable)
      .where(eq(activityLogsTable.ownerId, getOwnerId(req)))
      .orderBy(desc(activityLogsTable.createdAt))
      .limit(200);
    res.json(
      ListLogsResponse.parse(
        rows.map((row) => ({
          id: row.id,
          level: row.level,
          event: row.event,
          message: row.message,
          createdAt: row.createdAt.toISOString(),
        })),
      ),
    );
  } catch (error) {
    next(error);
  }
});

export default router;