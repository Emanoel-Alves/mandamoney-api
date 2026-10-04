import {
  AuthService,
  createLegacyBirthdayVerifier,
  MongoAuthStore,
} from "./auth.js";
import { CategoryService, MongoCategoryStore } from "./categories.js";
import { parseConfig, requireMongoUri } from "./config.js";
import { Database } from "./database.js";
import { FinanceService } from "./finance.js";
import { collectionNames, ensureIndexes, type UserDocument } from "./models.js";

const testDatabaseName = "mandamoney_test";
const testBirthday = "01/01/1990";
const testUsers = [
  { id: "test-user-main", name: "Conta de Teste", phone: "00000000001" },
  { id: "test-user-two", name: "Morador Teste 2", phone: "00000000002" },
  { id: "test-user-three", name: "Morador Teste 3", phone: "00000000003" },
] as const;
const categoryNames = [
  "Alimentícios",
  "Carnes",
  "Cereais",
  "Higiene",
  "Hortaliças",
  "Outros",
] as const;

async function main(): Promise<void> {
  const config = parseConfig();
  if (
    (config.nodeEnv === "production" &&
      process.env.ALLOW_TEST_SEED !== "true") ||
    config.mongoDatabase !== testDatabaseName
  ) {
    throw new Error(
      `Test seeding is allowed only when MONGODB_DATABASE=${testDatabaseName} and NODE_ENV is not production.`,
    );
  }
  if (!config.legacyAuthPepper) {
    throw new Error("LEGACY_AUTH_PEPPER is required to seed test accounts.");
  }
  const pepper = config.legacyAuthPepper;

  const database = new Database(requireMongoUri(config), testDatabaseName);
  try {
    const db = await database.connect();
    await database.assertTransactionsSupported();
    await ensureIndexes(db);
    const importedAt = new Date();
    const users = testUsers.map<UserDocument>((user) => {
      const verifier = createLegacyBirthdayVerifier(
        pepper,
        user.id,
        testBirthday,
      );
      if (!verifier) throw new Error("Test birthday fixture is invalid.");
      return {
        _id: user.id,
        legacyId: user.id,
        name: user.name,
        phoneNormalized: user.phone,
        legacyBirthdayVerifier: verifier,
        createdAt: importedAt,
        updatedAt: importedAt,
      };
    });
    for (const user of users) {
      await db
        .collection<UserDocument>(collectionNames.users)
        .updateOne({ _id: user._id }, { $setOnInsert: user }, { upsert: true });
      const existing = await db
        .collection<UserDocument>(collectionNames.users)
        .findOne({ _id: user._id });
      if (
        existing?.phoneNormalized !== user.phoneNormalized ||
        existing.legacyBirthdayVerifier !== user.legacyBirthdayVerifier
      ) {
        throw new Error(
          `Existing test user ${user._id} does not match the fixture.`,
        );
      }
    }

    const categories = new CategoryService(new MongoCategoryStore(database));
    for (const name of categoryNames) await categories.create(name);

    const finance = new FinanceService(database);
    const fixtureItems = [
      {
        key: "test-fixture-main-item-v1",
        buyerId: testUsers[0].id,
        product: "Item de teste - Compra compartilhada",
        market: "Mercado de Teste",
        valueCents: 2_000,
      },
      {
        key: "test-fixture-reciprocal-item-v1",
        buyerId: testUsers[1].id,
        product: "Item de teste - Saldo recíproco",
        market: "Mercado de Teste",
        valueCents: 1_200,
      },
    ] as const;
    for (const fixture of fixtureItems) {
      const existing = await db.collection(collectionNames.items).findOne({
        buyerId: fixture.buyerId,
        product: fixture.product,
      });
      if (existing) continue;
      await finance.saveItems(fixture.buyerId, fixture.key, [
        {
          date: "2026-10-03",
          market: fixture.market,
          product: fixture.product,
          category: "Alimentícios",
          valueCents: fixture.valueCents,
          buyerId: fixture.buyerId,
          participantIds: [testUsers[0].id, testUsers[1].id],
          paidDirectlyBy: [],
        },
      ]);
    }

    const auth = new AuthService(new MongoAuthStore(database), pepper);
    const login = await auth.login(testUsers[0].phone, testBirthday);
    if (!login || login === "disabled") {
      throw new Error("Seeded test account could not log in.");
    }
    console.log(
      JSON.stringify({
        database: testDatabaseName,
        syntheticUsers: testUsers.length,
        categories: categoryNames.length,
        fixtureItems: fixtureItems.length,
        loginVerified: true,
      }),
    );
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Test database seeding failed.";
  console.error(message);
  process.exitCode = 1;
});
