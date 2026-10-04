import { buildApp } from "./app.js";
import { AuthService, MongoAuthStore } from "./auth.js";
import { FinanceService } from "./finance.js";
import { ReceiptImportService } from "./integrations.js";
import { CategoryService, MongoCategoryStore } from "./categories.js";
import { ensureIndexes } from "./models.js";
import { parseConfig, requireMongoUri } from "./config.js";
import { createDatabase } from "./database.js";

const config = parseConfig();
const database = createDatabase({
  ...config,
  mongoUri: requireMongoUri(config),
});
const auth = new AuthService(
  new MongoAuthStore(database),
  config.legacyAuthPepper,
);
const app = await buildApp({
  config,
  database,
  auth,
  finance: new FinanceService(database),
  categories: new CategoryService(new MongoCategoryStore(database)),
  imports: new ReceiptImportService(config),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down API");
  await app.close();
  await database.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const db = await database.connect();
  await ensureIndexes(db);
  await database.assertTransactionsSupported();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "API failed to start");
  await database.close();
  process.exitCode = 1;
}
