import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ClientSession, Collection } from "mongodb";
import { parseConfig, requireMongoUri } from "./config.js";
import { Database } from "./database.js";
import { collectionNames, ensureIndexes } from "./models.js";
import { transformLegacyExports, type LegacyExportFiles } from "./migration.js";

const fileNames = [
  "Usuarios",
  "Compras_Itens",
  "Saldos",
  "Saldo_Itens",
  "Pagamentos",
  "Contestacoes",
] as const;

type ImportedMongoDocument = Record<string, unknown> & { _id: string };

async function main(): Promise<void> {
  const [sourceDirectory, ...flags] = process.argv.slice(2);
  if (
    !sourceDirectory ||
    flags.some((flag) => flag !== "--apply") ||
    new Set(flags).size !== flags.length
  ) {
    throw new Error(
      "Usage: npm run import:legacy -- <directory-with-csvs> [--apply]",
    );
  }

  const config = parseConfig();
  const apply = flags.includes("--apply");
  if (apply && config.nodeEnv === "production") {
    throw new Error("Legacy imports are disabled when NODE_ENV=production.");
  }
  if (apply && !config.legacyAuthPepper) {
    throw new Error(
      "LEGACY_AUTH_PEPPER is required to create legacy account verifiers.",
    );
  }

  const directory = resolve(sourceDirectory);
  const files = {} as LegacyExportFiles;
  for (const fileName of fileNames) {
    files[fileName] = await readFile(
      resolve(directory, `${fileName}.csv`),
      "utf8",
    );
  }

  const legacyAuthPepper =
    config.legacyAuthPepper ?? randomBytes(32).toString("hex");
  const report = transformLegacyExports(files, legacyAuthPepper);
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        counts: report.counts,
        rows: report.rows,
        totals: report.totals,
        invalidRows: [
          ...new Set(
            report.issues.map((issue) => `${issue.file}:${issue.row}`),
          ),
        ].length,
        issues: report.issues,
      },
      null,
      2,
    ),
  );
  if (report.issues.length) {
    throw new Error("CSV validation failed; no database writes were made.");
  }
  if (!apply) return;

  const database = new Database(requireMongoUri(config), config.mongoDatabase);
  try {
    const db = await database.connect();
    await database.assertTransactionsSupported();
    await ensureIndexes(db);
    await database.withTransaction(async (session) => {
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.users),
        report.documents.users,
        session,
        ["legacyBirthdayVerifier"],
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.items),
        report.documents.items,
        session,
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.categories),
        report.documents.categories,
        session,
        ["name", "normalizedName", "color"],
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.balances),
        report.documents.balances,
        session,
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.balanceItems),
        report.documents.balanceItems,
        session,
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.paymentRequests),
        report.documents.paymentRequests,
        session,
      );
      await upsertDocuments(
        db.collection<ImportedMongoDocument>(collectionNames.disputes),
        report.documents.disputes,
        session,
      );
    });
  } finally {
    await database.close();
  }
  console.log("Legacy CSV import committed successfully.");
}

async function upsertDocuments(
  collection: Collection<ImportedMongoDocument>,
  documents: Array<{ _id: string }>,
  session: ClientSession,
  insertOnlyFields: string[] = [],
): Promise<void> {
  if (documents.length === 0) return;
  const insertOnly = new Set([
    "_id",
    "createdAt",
    "updatedAt",
    ...insertOnlyFields,
  ]);
  await collection.bulkWrite(
    documents.map((document) => ({
      updateOne: {
        filter: { _id: document._id },
        update: {
          $set: Object.fromEntries(
            Object.entries(document).filter(([key]) => !insertOnly.has(key)),
          ),
          $setOnInsert: Object.fromEntries(
            Object.entries(document).filter(([key]) => insertOnly.has(key)),
          ),
        },
        upsert: true,
      },
    })),
    { session, ordered: true },
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Legacy import failed.";
  console.error(message);
  process.exitCode = 1;
});
