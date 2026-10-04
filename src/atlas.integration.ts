import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { parseConfig, requireMongoUri } from "./config.js";
import { Database } from "./database.js";
import { FinanceError, FinanceService } from "./finance.js";
import {
  collectionNames,
  ensureIndexes,
  type BalanceAdjustmentDocument,
  type BalanceDocument,
  type BalanceItemDocument,
  type DisputeDocument,
  type IdempotencyDocument,
  type ItemDocument,
  type PaymentRequestDocument,
  type UserDocument,
} from "./models.js";

type CreatedIds = {
  users: string[];
  items: string[];
  balances: string[];
  paymentRequests: string[];
  disputes: string[];
  adjustments: string[];
  idempotencyKeys: string[];
};

const config = parseConfig();

test(
  "Atlas transactions preserve state under retries and concurrent offsets",
  { skip: !config.mongoUri },
  async () => {
    if (config.nodeEnv === "production") {
      throw new Error(
        "Atlas integration tests must not use NODE_ENV=production.",
      );
    }

    const database = new Database(
      requireMongoUri(config),
      config.mongoDatabase,
    );
    const finance = new FinanceService(database);
    const marker = randomUUID();
    const ids: CreatedIds = {
      users: [
        "buyer",
        "debtor",
        "offset-debtor",
        "offset-creditor",
        "outsider",
      ].map((role) => `atlas-test-${marker}-${role}`),
      items: [],
      balances: [],
      paymentRequests: [],
      disputes: [],
      adjustments: [],
      idempotencyKeys: [],
    };

    try {
      const db = await database.connect();
      await database.assertTransactionsSupported();
      await ensureIndexes(db);
      const users = ids.users.map<UserDocument>((userId, index) => ({
        _id: userId,
        legacyId: userId,
        name: `API integration test ${index}`,
        phoneNormalized: `999${randomUUID().replace(/\D/g, "").slice(0, 10)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await db
        .collection<UserDocument>(collectionNames.users)
        .insertMany(users);

      const [buyerId, debtorId, offsetDebtorId, offsetCreditorId, outsiderId] =
        ids.users;
      assert.ok(
        buyerId && debtorId && offsetDebtorId && offsetCreditorId && outsiderId,
      );

      const rollbackItemId = `atlas-test-${marker}-rollback-item`;
      const rollbackBalanceId = `atlas-test-${marker}-rollback-balance`;
      ids.items.push(rollbackItemId);
      ids.balances.push(rollbackBalanceId);
      await assert.rejects(
        database.withTransaction(async (session) => {
          await db.collection<ItemDocument>(collectionNames.items).insertOne(
            {
              _id: rollbackItemId,
              legacyId: rollbackItemId,
              buyerId,
              date: "2026-10-03",
              market: "Rollback test",
              product: "Temporary rollback item",
              category: "test",
              amountCents: 100,
              participantIds: [buyerId],
              paidDirectlyBy: [],
              createdAt: new Date(),
            },
            { session },
          );
          await db
            .collection<BalanceDocument>(collectionNames.balances)
            .insertOne(
              {
                _id: rollbackBalanceId,
                legacyId: rollbackBalanceId,
                debtorId,
                creditorId: buyerId,
                amountCents: 100,
                status: "pending",
                paidAt: null,
                updatedAt: new Date(),
              },
              { session },
            );
          throw new Error("intentional transaction rollback");
        }),
        /intentional transaction rollback/,
      );
      assert.equal(
        await db
          .collection<ItemDocument>(collectionNames.items)
          .countDocuments({
            _id: rollbackItemId,
          }),
        0,
      );
      assert.equal(
        await db
          .collection<BalanceDocument>(collectionNames.balances)
          .countDocuments({ _id: rollbackBalanceId }),
        0,
      );

      const batchKey = `items-${marker}`;
      const itemInput = {
        date: "2026-10-03",
        market: "Integration test",
        product: `Temporary ${marker}`,
        category: "test",
        valueCents: 1001,
        buyerId,
        participantIds: [buyerId, debtorId],
        paidDirectlyBy: [],
      };

      rememberIdempotency(ids, buyerId, batchKey);
      const firstBatch = await finance.saveItems(buyerId, batchKey, [
        itemInput,
      ]);
      const replayedBatch = await finance.saveItems(buyerId, batchKey, [
        itemInput,
      ]);
      assert.deepEqual(replayedBatch, firstBatch);
      const batchBody = firstBatch.body as {
        items: { id: string }[];
        balanceIds: string[];
      };
      assert.equal(batchBody.items.length, 1);
      assert.equal(batchBody.balanceIds.length, 1);
      const itemId = batchBody.items[0]?.id;
      const paymentBalanceId = batchBody.balanceIds[0];
      assert.ok(itemId && paymentBalanceId);
      ids.items.push(itemId);
      ids.balances.push(paymentBalanceId);

      let outsiderCursor: string | undefined;
      let outsiderCanReadHouseholdItem = false;
      do {
        const outsiderItems = (await finance.listItems(
          outsiderId,
          "2026-10",
          outsiderCursor,
          100,
        )) as {
          items: { id: string; product: string }[];
          nextCursor: string | null;
        };
        outsiderCanReadHouseholdItem ||= outsiderItems.items.some(
          (item) => item.id === itemId && item.product === itemInput.product,
        );
        outsiderCursor = outsiderItems.nextCursor ?? undefined;
      } while (outsiderCursor);
      assert.equal(outsiderCanReadHouseholdItem, true);
      assert.deepEqual(await finance.getBalances(outsiderId), { balances: [] });
      const outsiderHousehold = (await finance.getHouseholdUsers(
        outsiderId,
      )) as { users: { id: string }[] };
      assert.ok(outsiderHousehold.users.some((user) => user.id === buyerId));
      assert.ok(outsiderHousehold.users.some((user) => user.id === debtorId));
      assert.ok(outsiderHousehold.users.some((user) => user.id === outsiderId));
      await assert.rejects(
        finance.getBalanceItems(outsiderId, paymentBalanceId),
        (error: unknown) =>
          error instanceof FinanceError && error.statusCode === 404,
      );
      await assert.rejects(
        finance.createDispute(
          outsiderId,
          paymentBalanceId,
          itemId,
          `outsider-dispute-${marker}`,
        ),
        (error: unknown) =>
          error instanceof FinanceError && error.statusCode === 409,
      );

      const links = await db
        .collection<BalanceItemDocument>(collectionNames.balanceItems)
        .find({ balanceId: paymentBalanceId })
        .toArray();
      assert.equal(links.length, 1);
      const pendingBalance = await db
        .collection<BalanceDocument>(collectionNames.balances)
        .findOne({ _id: paymentBalanceId });
      assert.equal(links[0]?.shareCents, pendingBalance?.amountCents);
      assert.ok([500, 501].includes(Number(links[0]?.shareCents)));
      const itemsAfterReplay = await db
        .collection<ItemDocument>(collectionNames.items)
        .countDocuments({ _id: itemId });
      assert.equal(itemsAfterReplay, 1);

      const requestPaymentKey = `payment-${marker}`;
      rememberIdempotency(ids, debtorId, requestPaymentKey);
      const paymentResult = await finance.requestPayment(
        debtorId,
        paymentBalanceId,
        requestPaymentKey,
      );
      assert.equal(paymentResult.statusCode, 201);
      const requestBody = paymentResult.body as {
        paymentRequest: { id: string };
      };
      const paymentRequestId = requestBody.paymentRequest.id;
      ids.paymentRequests.push(paymentRequestId);

      const outsiderConfirmKey = `outsider-confirm-${marker}`;
      rememberIdempotency(ids, outsiderId, outsiderConfirmKey);
      await assert.rejects(
        finance.confirmPayment(
          outsiderId,
          paymentRequestId,
          outsiderConfirmKey,
        ),
        (error: unknown) =>
          error instanceof FinanceError && error.statusCode === 404,
      );

      const confirmKey = `confirm-${marker}`;
      rememberIdempotency(ids, buyerId, confirmKey);
      const confirmation = await finance.confirmPayment(
        buyerId,
        paymentRequestId,
        confirmKey,
      );
      assert.equal(confirmation.statusCode, 200);
      const paidBalance = await db
        .collection<BalanceDocument>(collectionNames.balances)
        .findOne({ _id: paymentBalanceId });
      assert.equal(paidBalance?.status, "paid");

      const disputeKey = `dispute-item-${marker}`;
      rememberIdempotency(ids, buyerId, disputeKey);
      const disputedBatch = await finance.saveItems(buyerId, disputeKey, [
        {
          ...itemInput,
          product: `Disputed temporary ${marker}`,
          valueCents: 900,
        },
      ]);
      const disputedBody = disputedBatch.body as {
        items: { id: string }[];
        balanceIds: string[];
      };
      const disputedItemId = disputedBody.items[0]?.id;
      const disputeBalanceId = disputedBody.balanceIds[0];
      assert.ok(disputedItemId && disputeBalanceId);
      ids.items.push(disputedItemId);
      ids.balances.push(disputeBalanceId);

      const detailBeforeDispute = await finance.getBalanceItems(
        debtorId,
        disputeBalanceId,
      );
      assert.deepEqual(
        (
          detailBeforeDispute as { items: { itemId: string; value: number }[] }
        ).items.map((item) => [item.itemId, item.value]),
        [[disputedItemId, 4.5]],
      );

      const createDisputeKey = `create-dispute-${marker}`;
      rememberIdempotency(ids, debtorId, createDisputeKey);
      const disputeResult = await finance.createDispute(
        debtorId,
        disputeBalanceId,
        disputedItemId,
        createDisputeKey,
      );
      assert.equal(disputeResult.statusCode, 201);
      const disputeBody = disputeResult.body as { dispute: { id: string } };
      const disputeId = disputeBody.dispute.id;
      ids.disputes.push(disputeId);

      const pendingNotifications = await finance.notifications(buyerId);
      assert.deepEqual(
        (
          pendingNotifications as {
            disputes: { id: string; product: string }[];
          }
        ).disputes.map((notification) => [
          notification.id,
          notification.product,
        ]),
        [[disputeId, `Disputed temporary ${marker}`]],
      );

      const outsiderResolveKey = `outsider-resolve-${marker}`;
      rememberIdempotency(ids, outsiderId, outsiderResolveKey);
      await assert.rejects(
        finance.resolveDispute(
          outsiderId,
          disputeId,
          "accepted",
          outsiderResolveKey,
        ),
        (error: unknown) =>
          error instanceof FinanceError && error.statusCode === 404,
      );

      const resolveDisputeKey = `resolve-dispute-${marker}`;
      rememberIdempotency(ids, buyerId, resolveDisputeKey);
      const acceptedDispute = await finance.resolveDispute(
        buyerId,
        disputeId,
        "accepted",
        resolveDisputeKey,
      );
      assert.equal(acceptedDispute.statusCode, 200);
      assert.deepEqual(
        await finance.resolveDispute(
          buyerId,
          disputeId,
          "accepted",
          resolveDisputeKey,
        ),
        acceptedDispute,
      );
      const resolvedDetails = await finance.getBalanceItems(
        debtorId,
        disputeBalanceId,
      );
      assert.deepEqual(
        (
          resolvedDetails as {
            items: unknown[];
            disputes: { status: string }[];
          }
        ).items,
        [],
      );
      assert.deepEqual(
        (resolvedDetails as { disputes: { status: string }[] }).disputes.map(
          (dispute) => dispute.status,
        ),
        ["accepted"],
      );
      assert.deepEqual(
        (
          (await finance.getDisputes(debtorId)) as {
            disputes: { id: string; status: string }[];
          }
        ).disputes.map((dispute) => [dispute.id, dispute.status]),
        [[disputeId, "accepted"]],
      );

      const offsetBalances: BalanceDocument[] = [
        {
          _id: `atlas-test-${marker}-offset-a`,
          legacyId: `atlas-test-${marker}-offset-a`,
          debtorId: offsetDebtorId,
          creditorId: offsetCreditorId,
          amountCents: 12_345,
          status: "pending",
          paidAt: null,
          updatedAt: new Date(),
        },
        {
          _id: `atlas-test-${marker}-offset-b`,
          legacyId: `atlas-test-${marker}-offset-b`,
          debtorId: offsetCreditorId,
          creditorId: offsetDebtorId,
          amountCents: 5_000,
          status: "pending",
          paidAt: null,
          updatedAt: new Date(),
        },
      ];
      ids.balances.push(...offsetBalances.map((balance) => balance._id));
      await db
        .collection<BalanceDocument>(collectionNames.balances)
        .insertMany(offsetBalances);

      const outsiderOffsetKey = `outsider-offset-${marker}`;
      rememberIdempotency(ids, outsiderId, outsiderOffsetKey);
      await assert.rejects(
        finance.offsetBalance(
          outsiderId,
          offsetBalances[0]!._id,
          outsiderOffsetKey,
        ),
        (error: unknown) =>
          error instanceof FinanceError && error.statusCode === 409,
      );

      const offsetKeys = [`offset-a-${marker}`, `offset-b-${marker}`];
      offsetKeys.forEach((key) =>
        rememberIdempotency(ids, offsetDebtorId, key),
      );
      const attempts = await Promise.allSettled(
        offsetKeys.map((key) =>
          finance.offsetBalance(offsetDebtorId, offsetBalances[0]!._id, key),
        ),
      );
      const successful = attempts.filter(
        (attempt) => attempt.status === "fulfilled",
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );
      assert.equal(successful.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(
        rejected[0]?.reason instanceof FinanceError &&
          rejected[0].reason.statusCode === 409,
      );

      const resultingBalances = await db
        .collection<BalanceDocument>(collectionNames.balances)
        .find({ _id: { $in: offsetBalances.map((balance) => balance._id) } })
        .toArray();
      assert.deepEqual(
        resultingBalances
          .map((balance) => [balance.amountCents, balance.status])
          .sort((left, right) => Number(left[0]) - Number(right[0])),
        [
          [0, "offset"],
          [7_345, "pending"],
        ],
      );

      const adjustment = await db
        .collection<BalanceAdjustmentDocument>(
          collectionNames.balanceAdjustments,
        )
        .findOne({ balanceIds: offsetBalances[0]!._id });
      assert.ok(adjustment);
      assert.equal(adjustment.amountCents, 5_000);
      ids.adjustments.push(String(adjustment._id));
    } finally {
      try {
        const db = await database.connect();
        await Promise.all([
          db
            .collection<BalanceAdjustmentDocument>(
              collectionNames.balanceAdjustments,
            )
            .deleteMany({
              $or: [
                { _id: { $in: ids.adjustments } },
                { balanceIds: { $in: ids.balances } },
              ],
            }),
          db
            .collection<DisputeDocument>(collectionNames.disputes)
            .deleteMany({ _id: { $in: ids.disputes } }),
          db
            .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
            .deleteMany({ _id: { $in: ids.paymentRequests } }),
          db
            .collection<BalanceItemDocument>(collectionNames.balanceItems)
            .deleteMany({
              $or: [
                { balanceId: { $in: ids.balances } },
                { itemId: { $in: ids.items } },
              ],
            }),
          db
            .collection<BalanceDocument>(collectionNames.balances)
            .deleteMany({ _id: { $in: ids.balances } }),
          db
            .collection<ItemDocument>(collectionNames.items)
            .deleteMany({ _id: { $in: ids.items } }),
          db
            .collection<IdempotencyDocument>(collectionNames.idempotencyKeys)
            .deleteMany({ key: { $in: ids.idempotencyKeys } }),
          db
            .collection<UserDocument>(collectionNames.users)
            .deleteMany({ _id: { $in: ids.users } }),
        ]);
        const remainingCounts = await Promise.all([
          db.collection<UserDocument>(collectionNames.users).countDocuments({
            _id: { $in: ids.users },
          }),
          db.collection<ItemDocument>(collectionNames.items).countDocuments({
            _id: { $in: ids.items },
          }),
          db
            .collection<BalanceDocument>(collectionNames.balances)
            .countDocuments({ _id: { $in: ids.balances } }),
          db
            .collection<IdempotencyDocument>(collectionNames.idempotencyKeys)
            .countDocuments({ key: { $in: ids.idempotencyKeys } }),
        ]);
        assert.deepEqual(
          remainingCounts,
          [0, 0, 0, 0],
          "Atlas integration-test records should all be removed",
        );
      } finally {
        await database.close();
      }
    }
  },
);

function rememberIdempotency(
  ids: CreatedIds,
  userId: string,
  key: string,
): void {
  ids.idempotencyKeys.push(
    createHash("sha256").update(`${userId}:${key}`).digest("hex"),
  );
}
