import { and, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AddRecipientsBody,
  AddRecipientsResponse,
  ClearRecipientsResponse,
  DeleteRecipientParams,
  ImportRecipientsBody,
  ImportRecipientsResponse,
  ListRecipientsResponse,
} from "@workspace/api-zod";
import {
  campaignsTable,
  campaignRecipientsTable,
  db,
  recipientsTable,
} from "@workspace/db";
import { getOwnerId } from "../middlewares/workspace";
import { recordActivity } from "../lib/activity";

const router: IRouter = Router();

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function listForOwner(ownerId: string) {
  const rows = await db
    .select({
      id: recipientsTable.id,
      email: recipientsTable.email,
      name: recipientsTable.name,
      status: recipientsTable.status,
      createdAt: recipientsTable.createdAt,
    })
    .from(recipientsTable)
    .where(eq(recipientsTable.ownerId, ownerId))
    .orderBy(recipientsTable.createdAt);
  return ListRecipientsResponse.parse(
    rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  );
}

async function importRows(
  ownerId: string,
  rawRows: Array<{ email: string; name?: string | null }>,
) {
  const cleaned = rawRows.map((row) => {
    const email = row.email.trim();
    const normalizedEmail = email.toLowerCase();
    return {
      email,
      normalizedEmail,
      name: row.name?.trim() || null,
      isValid: isValidEmail(email),
      status: isValidEmail(email) ? "valid" : "invalid",
    };
  });
  const storable = cleaned.filter((row) => row.email.length > 0);
  const blankRows = cleaned.length - storable.length;
  let added = 0;
  if (storable.length > 0) {
    added = await db.transaction(async (tx) => {
      let insertedCount = 0;
      const insertBatchSize = 1_000;
      for (let offset = 0; offset < storable.length; offset += insertBatchSize) {
        const inserted = await tx
          .insert(recipientsTable)
          .values(
            storable
              .slice(offset, offset + insertBatchSize)
              .map((row) => ({ ...row, ownerId })),
          )
          .onConflictDoNothing()
          .returning({ id: recipientsTable.id });
        insertedCount += inserted.length;
      }
      return insertedCount;
    });
  }
  const invalid = cleaned.filter((row) => !row.isValid).length;
  const duplicates = Math.max(0, storable.length - added);
  return {
    added,
    duplicates,
    invalid,
    total: rawRows.length,
    blankRows,
  };
}

async function recipientHasActiveSend(
  ownerId: string,
  recipientId: number,
): Promise<boolean> {
  const [processing] = await db
    .select({ id: campaignRecipientsTable.id })
    .from(campaignRecipientsTable)
    .innerJoin(
      campaignsTable,
      eq(campaignRecipientsTable.campaignId, campaignsTable.id),
    )
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignRecipientsTable.recipientId, recipientId),
        eq(campaignRecipientsTable.status, "invitation-processing"),
      ),
    )
    .limit(1);
  if (processing) return true;

  const [pending] = await db
    .select({ id: campaignRecipientsTable.id })
    .from(campaignRecipientsTable)
    .innerJoin(
      campaignsTable,
      eq(campaignRecipientsTable.campaignId, campaignsTable.id),
    )
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignsTable.status, "running"),
        eq(campaignRecipientsTable.recipientId, recipientId),
        eq(campaignRecipientsTable.status, "pending"),
      ),
    )
    .limit(1);
  return Boolean(pending);
}

async function ownerHasActiveSend(ownerId: string): Promise<boolean> {
  const [running] = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignsTable.status, "running"),
      ),
    )
    .limit(1);
  if (running) return true;

  const [processing] = await db
    .select({ id: campaignRecipientsTable.id })
    .from(campaignRecipientsTable)
    .innerJoin(
      campaignsTable,
      eq(campaignRecipientsTable.campaignId, campaignsTable.id),
    )
    .where(
      and(
        eq(campaignsTable.ownerId, ownerId),
        eq(campaignRecipientsTable.status, "invitation-processing"),
      ),
    )
    .limit(1);
  return Boolean(processing);
}

router.get("/recipients", async (req, res, next) => {
  try {
    res.json(await listForOwner(getOwnerId(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/recipients", async (req, res, next) => {
  const parsed = AddRecipientsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Recipient data is invalid." });
    return;
  }
  try {
    const result = await importRows(getOwnerId(req), parsed.data.recipients);
    await recordActivity(
      getOwnerId(req),
      result.invalid > 0 ? "warning" : "info",
      "recipients-added",
      `${result.added} recipient records were added; ${result.duplicates} duplicates and ${result.invalid} invalid addresses were found.`,
    );
    res.status(201).json(
      AddRecipientsResponse.parse({
        added: result.added,
        duplicates: result.duplicates,
        invalid: result.invalid,
        total: result.total,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/recipients/import", async (req, res, next) => {
  const parsed = ImportRecipientsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Recipient import data is invalid." });
    return;
  }
  try {
    const result = await importRows(getOwnerId(req), parsed.data.recipients);
    await recordActivity(
      getOwnerId(req),
      result.invalid > 0 ? "warning" : "info",
      "recipients-imported",
      `CSV import reviewed: ${result.added} records added; ${result.duplicates} duplicates and ${result.invalid} invalid addresses found.`,
    );
    res.status(201).json(
      ImportRecipientsResponse.parse({
        added: result.added,
        duplicates: result.duplicates,
        invalid: result.invalid,
        total: result.total,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.delete("/recipients/clear", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    if (await ownerHasActiveSend(ownerId)) {
      res.status(409).json({
        error: "Wait for the current invitation send to finish before clearing recipients.",
      });
      return;
    }
    const deleted = await db
      .delete(recipientsTable)
      .where(eq(recipientsTable.ownerId, ownerId))
      .returning({ id: recipientsTable.id });
    await recordActivity(
      ownerId,
      "warning",
      "recipients-cleared",
      `${deleted.length} recipient records were cleared.`,
    );
    res.json(ClearRecipientsResponse.parse({ deleted: deleted.length }));
  } catch (error) {
    next(error);
  }
});

router.delete("/recipients/:id", async (req, res, next) => {
  const parsed = DeleteRecipientParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Recipient ID is invalid." });
    return;
  }
  try {
    const ownerId = getOwnerId(req);
    if (await recipientHasActiveSend(ownerId, parsed.data.id)) {
      res.status(409).json({
        error: "This recipient is part of an invitation send that is still processing. Wait for it to finish before deleting the recipient.",
      });
      return;
    }
    const deleted = await db
      .delete(recipientsTable)
      .where(
        and(
          eq(recipientsTable.id, parsed.data.id),
          eq(recipientsTable.ownerId, ownerId),
        ),
      )
      .returning({ id: recipientsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Recipient not found." });
      return;
    }
    await recordActivity(ownerId, "info", "recipient-deleted", "A recipient record was removed.");
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;