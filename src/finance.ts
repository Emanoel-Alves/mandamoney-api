import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db, Filter } from "mongodb";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./database.js";
import {
  requireAuthentication,
  type AuthService,
  type AuthenticatedUser,
} from "./auth.js";
import {
  collectionNames,
  type BalanceAdjustmentDocument,
  type BalanceDocument,
  type BalanceItemDocument,
  type BalanceStatus,
  type DisputeDocument,
  type IdempotencyDocument,
  type ItemDocument,
  type PaymentRequestDocument,
  type UserDocument,
} from "./models.js";

const idempotencyLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const pendingStatus = "pending" as const;

export class FinanceError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

type NewItemInput = {
  date: string;
  market: string;
  product: string;
  category?: string;
  valueCents: number;
  buyerId: string;
  participantIds: string[];
  paidDirectlyBy: string[];
};

type FinanceReply = { statusCode: number; body: unknown };

type UserNames = Map<string, string>;

export class FinanceService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async bootstrap(userId: string, month: string): Promise<unknown> {
    validateMonth(month);
    const db = await this.database.connect();
    const [user, itemsPage, balances, paymentRequests, disputes] =
      await Promise.all([
        db
          .collection<UserDocument>(collectionNames.users)
          .findOne({ _id: userId }, { projection: { _id: 1, name: 1 } }),
        this.findItemsForMonth(db, month),
        db
          .collection<BalanceDocument>(collectionNames.balances)
          .find({
            $or: [{ debtorId: userId }, { creditorId: userId }],
          })
          .sort({ updatedAt: -1, _id: -1 })
          .toArray(),
        db
          .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
          .find({
            creditorId: userId,
            status: "pending",
          })
          .toArray(),
        db
          .collection<DisputeDocument>(collectionNames.disputes)
          .find({
            creditorId: userId,
            status: "pending",
          })
          .toArray(),
      ]);
    if (!user) throw new FinanceError(404, "NOT_FOUND", "User not found.");
    const names = await this.loadUserNames(
      db,
      collectUserIds(balances, itemsPage.items),
    );
    return {
      user: { id: user._id, name: user.name },
      items: itemsPage.items.map((item) => serializeItem(item, names)),
      itemsNextCursor: itemsPage.nextCursor,
      balances: balances.map((balance) => serializeBalance(balance, names)),
      notifications: {
        paymentRequests: paymentRequests.length,
        disputes: disputes.length,
      },
    };
  }

  async listItems(
    _userId: string,
    month: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<unknown> {
    if (month) validateMonth(month);
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    const db = await this.database.connect();
    const base: Filter<ItemDocument> = month
      ? { date: { $regex: `^${month}` } }
      : {};
    const filter: Filter<ItemDocument> = decodedCursor
      ? {
          $and: [
            base,
            {
              $or: [
                { date: { $lt: decodedCursor.date } },
                { date: decodedCursor.date, _id: { $lt: decodedCursor.id } },
              ],
            },
          ],
        }
      : base;
    const rows = await db
      .collection<ItemDocument>(collectionNames.items)
      .find(filter)
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const names = await this.loadUserNames(db, collectUserIds([], items));
    const last = items.at(-1);
    return {
      items: items.map((item) => serializeItem(item, names)),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  async saveItems(
    userId: string,
    idempotencyKey: string,
    items: NewItemInput[],
  ): Promise<FinanceReply> {
    if (items.length < 1 || items.length > 100) {
      throw new FinanceError(
        400,
        "INVALID_REQUEST",
        "Provide between 1 and 100 items.",
      );
    }
    for (const item of items) validateNewItem(item, userId);
    return this.runIdempotently(
      userId,
      idempotencyKey,
      items,
      async (db, session) => {
        const userIds = [
          ...new Set(items.flatMap((item) => item.participantIds)),
        ];
        const foundUsers = await db
          .collection<UserDocument>(collectionNames.users)
          .find({ _id: { $in: userIds } }, { session, projection: { _id: 1 } })
          .toArray();
        if (foundUsers.length !== userIds.length) {
          throw new FinanceError(
            400,
            "INVALID_REQUEST",
            "One or more participants do not exist.",
          );
        }

        const createdItems: ItemDocument[] = [];
        const createdBalanceIds = new Set<string>();
        for (const input of items) {
          const id = randomUUID();
          const item: ItemDocument = {
            _id: id,
            legacyId: id,
            buyerId: userId,
            date: input.date,
            market: input.market.trim(),
            product: input.product.trim(),
            category: input.category?.trim() ?? "",
            amountCents: input.valueCents,
            participantIds: [...input.participantIds],
            paidDirectlyBy: [...input.paidDirectlyBy],
            createdAt: this.now(),
          };
          await db
            .collection<ItemDocument>(collectionNames.items)
            .insertOne(item, { session });
          createdItems.push(item);
          const shares = allocateShares(item.amountCents, item.participantIds);
          for (const debtorId of item.participantIds) {
            if (debtorId === userId || item.paidDirectlyBy.includes(debtorId))
              continue;
            const shareCents = shares.get(debtorId) ?? 0;
            if (shareCents <= 0) continue;
            const existing = await db
              .collection<BalanceDocument>(collectionNames.balances)
              .findOne(
                { debtorId, creditorId: userId, status: pendingStatus },
                { session },
              );
            let balance: BalanceDocument;
            if (existing) {
              const updated = await db
                .collection<BalanceDocument>(collectionNames.balances)
                .findOneAndUpdate(
                  { _id: existing._id, status: pendingStatus },
                  {
                    $inc: { amountCents: shareCents },
                    $set: { updatedAt: this.now() },
                  },
                  { session, returnDocument: "after" },
                );
              if (!updated) {
                throw new FinanceError(
                  409,
                  "CONFLICT",
                  "Balance changed while saving items.",
                );
              }
              balance = updated;
            } else {
              const balanceId = randomUUID();
              balance = {
                _id: balanceId,
                legacyId: balanceId,
                debtorId,
                creditorId: userId,
                amountCents: shareCents,
                status: pendingStatus,
                paidAt: null,
                updatedAt: this.now(),
              };
              await db
                .collection<BalanceDocument>(collectionNames.balances)
                .insertOne(balance, { session });
            }
            createdBalanceIds.add(balance._id);
            const link: BalanceItemDocument = {
              _id: randomUUID(),
              balanceId: balance._id,
              itemId: item._id,
              debtorId,
              creditorId: userId,
              shareCents,
            };
            await db
              .collection<BalanceItemDocument>(collectionNames.balanceItems)
              .insertOne(link, { session });
          }
        }
        return {
          statusCode: 201,
          body: {
            items: createdItems.map((item) => ({ id: item._id })),
            balanceIds: [...createdBalanceIds],
          },
        };
      },
    );
  }

  async getBalances(userId: string): Promise<unknown> {
    const db = await this.database.connect();
    const balances = await db
      .collection<BalanceDocument>(collectionNames.balances)
      .find({
        $or: [{ debtorId: userId }, { creditorId: userId }],
      })
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();
    const names = await this.loadUserNames(db, collectUserIds(balances, []));
    return {
      balances: balances.map((balance) => serializeBalance(balance, names)),
    };
  }

  async getHouseholdUsers(userId: string): Promise<unknown> {
    const db = await this.database.connect();
    const users = await db
      .collection<UserDocument>(collectionNames.users)
      .find({}, { projection: { _id: 1, name: 1 } })
      .sort({ name: 1, _id: 1 })
      .toArray();
    if (!users.some((user) => user._id === userId)) {
      throw new FinanceError(404, "NOT_FOUND", "User not found.");
    }
    return {
      users: users.map((user) => ({ id: user._id, name: user.name })),
    };
  }

  async getDisputes(userId: string): Promise<unknown> {
    const db = await this.database.connect();
    const disputes = await db
      .collection<DisputeDocument>(collectionNames.disputes)
      .find({ $or: [{ debtorId: userId }, { creditorId: userId }] })
      .sort({ requestedAt: -1, _id: -1 })
      .toArray();
    const itemIds = [...new Set(disputes.map((dispute) => dispute.itemId))];
    const [names, items] = await Promise.all([
      this.loadUserNames(
        db,
        disputes.flatMap((dispute) => [dispute.debtorId, dispute.creditorId]),
      ),
      db
        .collection<ItemDocument>(collectionNames.items)
        .find({ _id: { $in: itemIds } })
        .toArray(),
    ]);
    const productById = new Map(items.map((item) => [item._id, item.product]));
    return {
      disputes: disputes.map((dispute) => ({
        ...serializeDispute(dispute, names),
        product: productById.get(dispute.itemId) ?? "",
      })),
    };
  }

  async getBalanceItems(userId: string, balanceId: string): Promise<unknown> {
    const db = await this.database.connect();
    const balance = await db
      .collection<BalanceDocument>(collectionNames.balances)
      .findOne({
        _id: balanceId,
        $or: [{ debtorId: userId }, { creditorId: userId }],
      });
    if (!balance)
      throw new FinanceError(404, "NOT_FOUND", "Balance not found.");
    const [links, adjustments, disputes] = await Promise.all([
      db
        .collection<BalanceItemDocument>(collectionNames.balanceItems)
        .find({ balanceId, shareCents: { $gt: 0 } })
        .sort({ _id: 1 })
        .toArray(),
      db
        .collection<BalanceAdjustmentDocument>(
          collectionNames.balanceAdjustments,
        )
        .find({ balanceIds: balanceId })
        .sort({ createdAt: 1 })
        .toArray(),
      db
        .collection<DisputeDocument>(collectionNames.disputes)
        .find({ balanceId })
        .sort({ requestedAt: 1 })
        .toArray(),
    ]);
    const itemIds = [...new Set(links.map((link) => link.itemId))];
    const items = await db
      .collection<ItemDocument>(collectionNames.items)
      .find({ _id: { $in: itemIds } })
      .toArray();
    const itemsById = new Map(items.map((item) => [item._id, item]));
    const names = await this.loadUserNames(
      db,
      collectUserIds([balance], items),
    );
    return {
      items: links.map((link) => {
        const item = itemsById.get(link.itemId);
        return {
          itemId: link.itemId,
          shareCents: link.shareCents,
          value: link.shareCents / 100,
          product: item?.product ?? "",
          date: item?.date ?? "",
          market: item?.market ?? "",
        };
      }),
      disputes: disputes.map((dispute) => serializeDispute(dispute, names)),
      adjustments: adjustments.map((adjustment) => ({
        id: adjustment._id,
        balanceIds: adjustment.balanceIds,
        amountCents: adjustment.amountCents,
        createdAt: adjustment.createdAt.toISOString(),
      })),
    };
  }

  async requestPayment(
    userId: string,
    balanceId: string,
    idempotencyKey: string,
  ): Promise<FinanceReply> {
    return this.runIdempotently(
      userId,
      idempotencyKey,
      { balanceId },
      async (db, session) => {
        const balance = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .findOne(
            {
              _id: balanceId,
              debtorId: userId,
              status: pendingStatus,
            },
            { session },
          );
        if (!balance)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Only the debtor can request payment for a pending balance.",
          );
        const requestId = randomUUID();
        const request: PaymentRequestDocument = {
          _id: requestId,
          legacyId: requestId,
          balanceId,
          debtorId: balance.debtorId,
          creditorId: balance.creditorId,
          amountCents: balance.amountCents,
          status: "pending",
          requestedAt: this.now(),
          resolvedAt: null,
        };
        const update = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .updateOne(
            {
              _id: balanceId,
              status: pendingStatus,
              amountCents: balance.amountCents,
            },
            {
              $set: { status: "awaiting_confirmation", updatedAt: this.now() },
            },
            { session },
          );
        if (update.modifiedCount !== 1)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Balance is no longer payable.",
          );
        await db
          .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
          .insertOne(request, { session });
        return {
          statusCode: 201,
          body: { paymentRequest: serializePaymentRequest(request) },
        };
      },
    );
  }

  async confirmPayment(
    userId: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<FinanceReply> {
    return this.runIdempotently(
      userId,
      idempotencyKey,
      { requestId },
      async (db, session) => {
        const request = await db
          .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
          .findOne(
            {
              _id: requestId,
              creditorId: userId,
              status: "pending",
            },
            { session },
          );
        if (!request)
          throw new FinanceError(
            404,
            "NOT_FOUND",
            "Pending payment request not found.",
          );
        const now = this.now();
        const balanceUpdate = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .updateOne(
            {
              _id: request.balanceId,
              creditorId: userId,
              debtorId: request.debtorId,
              status: "awaiting_confirmation",
              amountCents: request.amountCents,
            },
            { $set: { status: "paid", paidAt: now, updatedAt: now } },
            { session },
          );
        if (balanceUpdate.modifiedCount !== 1)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Balance is no longer awaiting confirmation.",
          );
        await db
          .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
          .updateOne(
            { _id: requestId, status: "pending" },
            { $set: { status: "confirmed", resolvedAt: now } },
            { session },
          );
        return {
          statusCode: 200,
          body: { status: "confirmed", balanceId: request.balanceId },
        };
      },
    );
  }

  async createDispute(
    userId: string,
    balanceId: string,
    itemId: string,
    idempotencyKey: string,
  ): Promise<FinanceReply> {
    return this.runIdempotently(
      userId,
      idempotencyKey,
      { balanceId, itemId },
      async (db, session) => {
        const balance = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .findOne(
            {
              _id: balanceId,
              debtorId: userId,
              status: pendingStatus,
            },
            { session },
          );
        if (!balance)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Only the debtor can dispute an item on a pending balance.",
          );
        const link = await db
          .collection<BalanceItemDocument>(collectionNames.balanceItems)
          .findOne(
            {
              balanceId,
              itemId,
              debtorId: userId,
              creditorId: balance.creditorId,
            },
            { session },
          );
        if (
          !link ||
          link.shareCents <= 0 ||
          balance.amountCents < link.shareCents
        ) {
          throw new FinanceError(
            409,
            "CONFLICT",
            "Item does not have a disputable share in this balance.",
          );
        }
        const existing = await db
          .collection<DisputeDocument>(collectionNames.disputes)
          .findOne({ balanceId, itemId }, { session });
        if (existing)
          throw new FinanceError(
            409,
            "CONFLICT",
            "This item already has a dispute.",
          );
        const disputeId = randomUUID();
        const dispute: DisputeDocument = {
          _id: disputeId,
          legacyId: disputeId,
          balanceId,
          itemId,
          debtorId: userId,
          creditorId: balance.creditorId,
          amountCents: link.shareCents,
          status: "pending",
          requestedAt: this.now(),
          resolvedAt: null,
        };
        const changed = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .updateOne(
            { _id: balanceId, status: pendingStatus },
            { $set: { status: "contest_pending", updatedAt: this.now() } },
            { session },
          );
        if (changed.modifiedCount !== 1)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Balance is no longer pending.",
          );
        await db
          .collection<DisputeDocument>(collectionNames.disputes)
          .insertOne(dispute, { session });
        return {
          statusCode: 201,
          body: { dispute: serializeDispute(dispute) },
        };
      },
    );
  }

  async resolveDispute(
    userId: string,
    disputeId: string,
    decision: "accepted" | "rejected",
    idempotencyKey: string,
  ): Promise<FinanceReply> {
    return this.runIdempotently(
      userId,
      idempotencyKey,
      { disputeId, decision },
      async (db, session) => {
        const dispute = await db
          .collection<DisputeDocument>(collectionNames.disputes)
          .findOne(
            {
              _id: disputeId,
              creditorId: userId,
              status: "pending",
            },
            { session },
          );
        if (!dispute)
          throw new FinanceError(
            404,
            "NOT_FOUND",
            "Pending dispute not found.",
          );
        const balance = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .findOne(
            {
              _id: dispute.balanceId,
              creditorId: userId,
              debtorId: dispute.debtorId,
              status: "contest_pending",
            },
            { session },
          );
        if (!balance)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Balance is not awaiting dispute resolution.",
          );
        const now = this.now();
        if (decision === "accepted") {
          if (balance.amountCents < dispute.amountCents) {
            throw new FinanceError(
              409,
              "CONFLICT",
              "Balance no longer contains the disputed amount.",
            );
          }
          const resolution = calculateDisputeResult(
            balance.amountCents,
            dispute.amountCents,
          );
          const { amountCents, status } = resolution;
          const updated = await db
            .collection<BalanceDocument>(collectionNames.balances)
            .updateOne(
              {
                _id: balance._id,
                status: "contest_pending",
                amountCents: balance.amountCents,
              },
              { $set: { amountCents, status, updatedAt: now } },
              { session },
            );
          if (updated.modifiedCount !== 1)
            throw new FinanceError(
              409,
              "CONFLICT",
              "Balance changed while resolving dispute.",
            );
          await db
            .collection<BalanceItemDocument>(collectionNames.balanceItems)
            .updateOne(
              { balanceId: balance._id, itemId: dispute.itemId },
              { $set: { shareCents: 0 } },
              { session },
            );
        } else {
          const updated = await db
            .collection<BalanceDocument>(collectionNames.balances)
            .updateOne(
              { _id: balance._id, status: "contest_pending" },
              { $set: { status: pendingStatus, updatedAt: now } },
              { session },
            );
          if (updated.modifiedCount !== 1)
            throw new FinanceError(
              409,
              "CONFLICT",
              "Balance changed while resolving dispute.",
            );
        }
        await db
          .collection<DisputeDocument>(collectionNames.disputes)
          .updateOne(
            { _id: disputeId, status: "pending" },
            { $set: { status: decision, resolvedAt: now } },
            { session },
          );
        return {
          statusCode: 200,
          body: { status: decision, balanceId: balance._id },
        };
      },
    );
  }

  async offsetBalance(
    userId: string,
    balanceId: string,
    idempotencyKey: string,
  ): Promise<FinanceReply> {
    return this.runIdempotently(
      userId,
      idempotencyKey,
      { balanceId },
      async (db, session, scopedKey) => {
        const selected = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .findOne(
            {
              _id: balanceId,
              status: pendingStatus,
              $or: [{ debtorId: userId }, { creditorId: userId }],
            },
            { session },
          );
        if (!selected)
          throw new FinanceError(
            409,
            "CONFLICT",
            "Balance is not pending or does not involve the authenticated user.",
          );
        const counterpart = await db
          .collection<BalanceDocument>(collectionNames.balances)
          .findOne(
            {
              debtorId: selected.creditorId,
              creditorId: selected.debtorId,
              status: pendingStatus,
            },
            { session },
          );
        if (!counterpart)
          throw new FinanceError(
            409,
            "CONFLICT",
            "No reciprocal pending balance exists.",
          );
        if (selected.amountCents <= 0 || counterpart.amountCents <= 0) {
          throw new FinanceError(
            409,
            "CONFLICT",
            "Both balances must have a positive amount.",
          );
        }
        const offset = calculateOffset(
          selected.amountCents,
          counterpart.amountCents,
        );
        const { amountCents } = offset;
        const now = this.now();
        for (const balance of [selected, counterpart]) {
          const remaining =
            balance._id === selected._id
              ? offset.firstRemainingCents
              : offset.secondRemainingCents;
          const updated = await db
            .collection<BalanceDocument>(collectionNames.balances)
            .updateOne(
              {
                _id: balance._id,
                status: pendingStatus,
                amountCents: balance.amountCents,
              },
              {
                $set: {
                  amountCents: remaining,
                  status: remaining === 0 ? "offset" : pendingStatus,
                  updatedAt: now,
                },
              },
              { session },
            );
          if (updated.modifiedCount !== 1)
            throw new FinanceError(
              409,
              "CONFLICT",
              "A reciprocal balance changed during offset.",
            );
        }
        const adjustmentId = randomUUID();
        const adjustment: BalanceAdjustmentDocument = {
          _id: adjustmentId,
          idempotencyKey: scopedKey,
          balanceIds: [selected._id, counterpart._id],
          actorId: userId,
          amountCents,
          createdAt: now,
        };
        await db
          .collection<BalanceAdjustmentDocument>(
            collectionNames.balanceAdjustments,
          )
          .insertOne(adjustment, { session });
        const updatedBalances: BalanceDocument[] = [
          {
            ...selected,
            amountCents: offset.firstRemainingCents,
            status: offset.firstRemainingCents === 0 ? "offset" : pendingStatus,
            updatedAt: now,
          },
          {
            ...counterpart,
            amountCents: offset.secondRemainingCents,
            status:
              offset.secondRemainingCents === 0 ? "offset" : pendingStatus,
            updatedAt: now,
          },
        ];
        return {
          statusCode: 200,
          body: {
            adjustment: {
              id: adjustmentId,
              balanceIds: adjustment.balanceIds,
              amountCents,
              createdAt: now.toISOString(),
            },
            balances: updatedBalances.map((balance) =>
              serializeBalance(balance),
            ),
          },
        };
      },
    );
  }

  async notifications(userId: string): Promise<unknown> {
    const db = await this.database.connect();
    const [paymentRequests, disputes] = await Promise.all([
      db
        .collection<PaymentRequestDocument>(collectionNames.paymentRequests)
        .find({ creditorId: userId, status: "pending" })
        .sort({ requestedAt: -1 })
        .toArray(),
      db
        .collection<DisputeDocument>(collectionNames.disputes)
        .find({ creditorId: userId, status: "pending" })
        .sort({ requestedAt: -1 })
        .toArray(),
    ]);
    const itemIds = [...new Set(disputes.map((dispute) => dispute.itemId))];
    const disputedItems = await db
      .collection<ItemDocument>(collectionNames.items)
      .find({ _id: { $in: itemIds } }, { projection: { _id: 1, product: 1 } })
      .toArray();
    const productById = new Map(
      disputedItems.map((item) => [item._id, item.product]),
    );
    const userIds = [
      ...paymentRequests.flatMap((request) => [
        request.debtorId,
        request.creditorId,
      ]),
      ...disputes.flatMap((dispute) => [dispute.debtorId, dispute.creditorId]),
    ];
    const names = await this.loadUserNames(db, userIds);
    return {
      paymentRequests: paymentRequests.map((request) => ({
        ...serializePaymentRequest(request, names),
        type: "payment_request",
      })),
      disputes: disputes.map((dispute) => ({
        ...serializeDispute(dispute, names),
        product: productById.get(dispute.itemId) ?? "",
        type: "contest_request",
      })),
    };
  }

  private async findItemsForMonth(
    db: Db,
    month: string,
  ): Promise<{ items: ItemDocument[]; nextCursor: string | null }> {
    const rows = await db
      .collection<ItemDocument>(collectionNames.items)
      .find({ date: { $regex: `^${month}` } })
      .sort({ date: -1, _id: -1 })
      .limit(101)
      .toArray();
    const hasMore = rows.length > 100;
    const items = hasMore ? rows.slice(0, 100) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  private async loadUserNames(db: Db, userIds: string[]): Promise<UserNames> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return new Map();
    const users = await db
      .collection<UserDocument>(collectionNames.users)
      .find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } })
      .toArray();
    return new Map(users.map((user) => [user._id, user.name]));
  }

  private async runIdempotently(
    userId: string,
    idempotencyKey: string,
    request: unknown,
    operation: (
      db: Db,
      session: ClientSession,
      scopedKey: string,
    ) => Promise<FinanceReply>,
  ): Promise<FinanceReply> {
    const key = idempotencyKey.trim();
    if (key.length < 16 || key.length > 128) {
      throw new FinanceError(
        400,
        "INVALID_REQUEST",
        "Idempotency-Key must contain 16 to 128 characters.",
      );
    }
    const scopedKey = createHash("sha256")
      .update(`${userId}:${key}`)
      .digest("hex");
    const requestHash = createHash("sha256")
      .update(stableStringify(request))
      .digest("hex");
    const db = await this.database.connect();
    const idempotency = db.collection<IdempotencyDocument>(
      collectionNames.idempotencyKeys,
    );

    const run = async (): Promise<FinanceReply> =>
      this.database.withTransaction(async (session) => {
        const existing = await idempotency.findOne(
          { key: scopedKey },
          { session },
        );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new FinanceError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was already used for a different request.",
            );
          }
          return existing.response as FinanceReply;
        }
        const result = await operation(db, session, scopedKey);
        await idempotency.insertOne(
          {
            key: scopedKey,
            requestHash,
            response: result,
            expiresAt: new Date(this.now().getTime() + idempotencyLifetimeMs),
          },
          { session },
        );
        return result;
      });

    try {
      return await run();
    } catch (error) {
      const existing = await idempotency.findOne({ key: scopedKey });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new FinanceError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different request.",
          );
        }
        return existing.response as FinanceReply;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      ) {
        throw new FinanceError(
          409,
          "CONFLICT",
          "A conflicting operation was committed concurrently; reload and retry with a new idempotency key.",
        );
      }
      throw error;
    }
  }
}

export type FinanceApi = Pick<
  FinanceService,
  | "bootstrap"
  | "listItems"
  | "saveItems"
  | "getBalances"
  | "getHouseholdUsers"
  | "getDisputes"
  | "getBalanceItems"
  | "requestPayment"
  | "confirmPayment"
  | "createDispute"
  | "resolveDispute"
  | "offsetBalance"
  | "notifications"
>;

export function registerFinanceRoutes(
  app: FastifyInstance,
  finance: FinanceApi,
  auth: AuthService,
): void {
  app.get<{ Querystring: { month?: string; cursor?: string; limit?: number } }>(
    "/api/v1/bootstrap",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { month: { type: "string", pattern: "^\\d{4}-\\d{2}$" } },
        },
      },
    },
    async (request) =>
      finance.bootstrap(
        request.authUser!.id,
        request.query.month ?? currentMonth(),
      ),
  );

  app.get<{ Querystring: { month?: string; cursor?: string; limit?: number } }>(
    "/api/v1/items",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            month: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
            cursor: { type: "string", maxLength: 256 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    },
    async (request) =>
      finance.listItems(
        request.authUser!.id,
        request.query.month,
        request.query.cursor,
        request.query.limit ?? 50,
      ),
  );

  app.post<{ Body: { items: NewItemInput[] } }>(
    "/api/v1/items/batch",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        headers: idempotencyHeaderSchema,
        body: {
          type: "object",
          required: ["items"],
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: newItemSchema,
            },
          },
        },
      },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.saveItems(
          request.authUser!.id,
          getIdempotencyKey(request),
          request.body.items,
        ),
      ),
  );

  app.get(
    "/api/v1/balances",
    { preHandler: requireAuthentication(auth) },
    async (request) => finance.getBalances(request.authUser!.id),
  );

  app.get(
    "/api/v1/household/users",
    { preHandler: requireAuthentication(auth) },
    async (request) => finance.getHouseholdUsers(request.authUser!.id),
  );

  app.get(
    "/api/v1/disputes",
    { preHandler: requireAuthentication(auth) },
    async (request) => finance.getDisputes(request.authUser!.id),
  );

  app.get<{ Params: { balanceId: string } }>(
    "/api/v1/balances/:balanceId/items",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        params: {
          type: "object",
          required: ["balanceId"],
          properties: {
            balanceId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request) =>
      finance.getBalanceItems(request.authUser!.id, request.params.balanceId),
  );

  app.post<{ Params: { balanceId: string } }>(
    "/api/v1/balances/:balanceId/payment-requests",
    {
      preHandler: requireAuthentication(auth),
      schema: { params: balanceIdParams, headers: idempotencyHeaderSchema },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.requestPayment(
          request.authUser!.id,
          request.params.balanceId,
          getIdempotencyKey(request),
        ),
      ),
  );

  app.post<{ Params: { requestId: string } }>(
    "/api/v1/payment-requests/:requestId/confirm",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        params: {
          type: "object",
          required: ["requestId"],
          properties: {
            requestId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        headers: idempotencyHeaderSchema,
      },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.confirmPayment(
          request.authUser!.id,
          request.params.requestId,
          getIdempotencyKey(request),
        ),
      ),
  );

  app.post<{ Params: { balanceId: string }; Body: { itemId: string } }>(
    "/api/v1/balances/:balanceId/disputes",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        params: balanceIdParams,
        headers: idempotencyHeaderSchema,
        body: {
          type: "object",
          required: ["itemId"],
          additionalProperties: false,
          properties: {
            itemId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.createDispute(
          request.authUser!.id,
          request.params.balanceId,
          request.body.itemId,
          getIdempotencyKey(request),
        ),
      ),
  );

  app.post<{
    Params: { disputeId: string };
    Body: { decision: "accepted" | "rejected" };
  }>(
    "/api/v1/disputes/:disputeId/resolve",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        params: {
          type: "object",
          required: ["disputeId"],
          properties: {
            disputeId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        headers: idempotencyHeaderSchema,
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: {
            decision: { type: "string", enum: ["accepted", "rejected"] },
          },
        },
      },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.resolveDispute(
          request.authUser!.id,
          request.params.disputeId,
          request.body.decision,
          getIdempotencyKey(request),
        ),
      ),
  );

  app.post<{ Params: { balanceId: string } }>(
    "/api/v1/balances/:balanceId/offset",
    {
      preHandler: requireAuthentication(auth),
      schema: { params: balanceIdParams, headers: idempotencyHeaderSchema },
    },
    async (request, reply) =>
      sendFinanceReply(
        reply,
        await finance.offsetBalance(
          request.authUser!.id,
          request.params.balanceId,
          getIdempotencyKey(request),
        ),
      ),
  );

  app.get(
    "/api/v1/notifications",
    { preHandler: requireAuthentication(auth) },
    async (request) => finance.notifications(request.authUser!.id),
  );
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    authToken: string | null;
  }
}

const idempotencyHeaderSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", minLength: 16, maxLength: 128 },
  },
} as const;

const balanceIdParams = {
  type: "object",
  required: ["balanceId"],
  properties: {
    balanceId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const newItemSchema = {
  type: "object",
  required: [
    "date",
    "market",
    "product",
    "valueCents",
    "participantIds",
    "paidDirectlyBy",
  ],
  additionalProperties: false,
  properties: {
    date: { type: "string", format: "date" },
    market: { type: "string", maxLength: 200 },
    product: { type: "string", minLength: 1, maxLength: 300 },
    category: { type: "string", maxLength: 100 },
    valueCents: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    buyerId: { type: "string", maxLength: 100 },
    participantIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    paidDirectlyBy: {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

function getIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string") {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Idempotency-Key header is required.",
    );
  }
  return key;
}

function sendFinanceReply(
  reply: import("fastify").FastifyReply,
  result: FinanceReply,
) {
  return reply.code(result.statusCode).send(result.body);
}

export function calculateOffset(
  firstAmountCents: number,
  secondAmountCents: number,
): {
  amountCents: number;
  firstRemainingCents: number;
  secondRemainingCents: number;
} {
  if (
    !Number.isSafeInteger(firstAmountCents) ||
    !Number.isSafeInteger(secondAmountCents) ||
    firstAmountCents <= 0 ||
    secondAmountCents <= 0
  ) {
    throw new RangeError(
      "Both reciprocal balances must be positive integer cents.",
    );
  }
  const amountCents = Math.min(firstAmountCents, secondAmountCents);
  return {
    amountCents,
    firstRemainingCents: firstAmountCents - amountCents,
    secondRemainingCents: secondAmountCents - amountCents,
  };
}

export function calculateDisputeResult(
  currentAmountCents: number,
  disputedAmountCents: number,
): { amountCents: number; status: "pending" | "contested" } {
  if (
    !Number.isSafeInteger(currentAmountCents) ||
    !Number.isSafeInteger(disputedAmountCents) ||
    currentAmountCents < 0 ||
    disputedAmountCents <= 0 ||
    disputedAmountCents > currentAmountCents
  ) {
    throw new RangeError(
      "Disputed amount must be positive and no greater than the balance.",
    );
  }
  const amountCents = currentAmountCents - disputedAmountCents;
  return {
    amountCents,
    status: amountCents === 0 ? "contested" : pendingStatus,
  };
}

export function validateNewItem(item: NewItemInput, userId: string): void {
  if (item.buyerId !== undefined && item.buyerId !== userId) {
    throw new FinanceError(
      403,
      "FORBIDDEN",
      "Items can only be saved for the authenticated buyer.",
    );
  }
  if (!isValidDate(item.date))
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Item date must be a valid YYYY-MM-DD date.",
    );
  if (!Number.isSafeInteger(item.valueCents) || item.valueCents <= 0) {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Item value must be a positive integer number of cents.",
    );
  }
  if (!item.market.trim() || !item.product.trim()) {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Market and product are required.",
    );
  }
  if (
    item.participantIds.length > 20 ||
    !item.participantIds.includes(userId)
  ) {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Participants must include the authenticated buyer and stay within the supported limit.",
    );
  }
  if (item.paidDirectlyBy.some((id) => !item.participantIds.includes(id))) {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Direct payers must be participants in the item.",
    );
  }
}

export function allocateShares(
  amountCents: number,
  participantIds: string[],
): Map<string, number> {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 0 ||
    participantIds.length === 0
  ) {
    throw new RangeError(
      "A non-negative integer amount and participants are required.",
    );
  }
  const uniqueParticipants = [...new Set(participantIds)].sort();
  const base = Math.floor(amountCents / uniqueParticipants.length);
  let remainder = amountCents - base * uniqueParticipants.length;
  return new Map(
    uniqueParticipants.map((participantId) => {
      const share = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      return [participantId, share];
    }),
  );
}

function serializeItem(item: ItemDocument, names: UserNames = new Map()) {
  return {
    id: item._id,
    date: item.date,
    market: item.market,
    product: item.product,
    category: item.category,
    valueCents: item.amountCents,
    value: item.amountCents / 100,
    buyerId: item.buyerId,
    buyerName: names.get(item.buyerId) ?? "",
    participantIds: item.participantIds,
    paidDirectlyBy: item.paidDirectlyBy,
  };
}

function serializeBalance(
  balance: BalanceDocument,
  names: UserNames = new Map(),
) {
  return {
    id: balance._id,
    debtorId: balance.debtorId,
    debtorName: names.get(balance.debtorId) ?? "",
    creditorId: balance.creditorId,
    creditorName: names.get(balance.creditorId) ?? "",
    amountCents: balance.amountCents,
    value: balance.amountCents / 100,
    status: balance.status,
    paidAt: balance.paidAt?.toISOString() ?? null,
  };
}

function serializePaymentRequest(
  request: PaymentRequestDocument,
  names: UserNames = new Map(),
) {
  return {
    id: request._id,
    balanceId: request.balanceId,
    debtorId: request.debtorId,
    debtorName: names.get(request.debtorId) ?? "",
    creditorId: request.creditorId,
    creditorName: names.get(request.creditorId) ?? "",
    amountCents: request.amountCents,
    value: request.amountCents / 100,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
  };
}

function serializeDispute(
  dispute: DisputeDocument,
  names: UserNames = new Map(),
) {
  return {
    id: dispute._id,
    balanceId: dispute.balanceId,
    itemId: dispute.itemId,
    debtorId: dispute.debtorId,
    debtorName: names.get(dispute.debtorId) ?? "",
    creditorId: dispute.creditorId,
    creditorName: names.get(dispute.creditorId) ?? "",
    amountCents: dispute.amountCents,
    value: dispute.amountCents / 100,
    status: dispute.status,
    requestedAt: dispute.requestedAt.toISOString(),
    resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
  };
}

function collectUserIds(
  balances: BalanceDocument[],
  items: ItemDocument[],
): string[] {
  return [
    ...balances.flatMap((balance) => [balance.debtorId, balance.creditorId]),
    ...items.flatMap((item) => [item.buyerId, ...item.participantIds]),
  ];
}

function encodeCursor(item: Pick<ItemDocument, "_id" | "date">): string {
  return Buffer.from(
    JSON.stringify({ id: item._id, date: item.date }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { id: string; date: string } {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "date" in value &&
      typeof value.id === "string" &&
      typeof value.date === "string" &&
      isValidDate(value.date)
    ) {
      return { id: value.id, date: value.date };
    }
  } catch {
    // Fall through to the explicit invalid-cursor error.
  }
  throw new FinanceError(400, "INVALID_REQUEST", "Cursor is invalid.");
}

function validateMonth(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new FinanceError(
      400,
      "INVALID_REQUEST",
      "Month must use YYYY-MM format.",
    );
  }
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts();
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month)
    throw new Error("Could not determine the current month.");
  return `${year}-${month}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
