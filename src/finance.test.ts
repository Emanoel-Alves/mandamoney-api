import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import {
  allocateShares,
  calculateDisputeResult,
  calculateOffset,
  FinanceError,
  type FinanceApi,
  validateNewItem,
} from "./finance.js";
import type { AuthStore } from "./auth.js";

const accessToken = "a".repeat(43);
const tokenHash = createHash("sha256").update(accessToken).digest("hex");

function buildFinanceApi(calls: unknown[][] = []): FinanceApi {
  return {
    async bootstrap(userId, month) {
      calls.push(["bootstrap", userId, month]);
      return {
        user: { id: userId, name: "Test" },
        items: [],
        balances: [],
        notifications: { paymentRequests: 0, disputes: 0 },
      };
    },
    async listItems(userId, month, cursor, limit) {
      calls.push(["listItems", userId, month, cursor, limit]);
      return { items: [], nextCursor: null };
    },
    async saveItems(userId, key, items) {
      calls.push(["saveItems", userId, key, items]);
      return { statusCode: 201, body: { items: [] } };
    },
    async getBalances(userId) {
      calls.push(["getBalances", userId]);
      return { balances: [] };
    },
    async getHouseholdUsers(userId) {
      calls.push(["getHouseholdUsers", userId]);
      return {
        users: [
          { id: "another-household-member", name: "Another member" },
          { id: userId, name: "Test" },
        ],
      };
    },
    async getDisputes(userId) {
      calls.push(["getDisputes", userId]);
      return { disputes: [] };
    },
    async getBalanceItems(userId, balanceId) {
      calls.push(["getBalanceItems", userId, balanceId]);
      return { items: [], disputes: [], adjustments: [] };
    },
    async requestPayment(userId, balanceId, key) {
      calls.push(["requestPayment", userId, balanceId, key]);
      return { statusCode: 201, body: {} };
    },
    async confirmPayment(userId, requestId, key) {
      calls.push(["confirmPayment", userId, requestId, key]);
      return { statusCode: 200, body: {} };
    },
    async createDispute(userId, balanceId, itemId, key) {
      calls.push(["createDispute", userId, balanceId, itemId, key]);
      return { statusCode: 201, body: {} };
    },
    async resolveDispute(userId, disputeId, decision, key) {
      calls.push(["resolveDispute", userId, disputeId, decision, key]);
      return { statusCode: 200, body: {} };
    },
    async offsetBalance(userId, balanceId, key) {
      calls.push(["offsetBalance", userId, balanceId, key]);
      return { statusCode: 200, body: {} };
    },
    async notifications(userId) {
      calls.push(["notifications", userId]);
      return { paymentRequests: [], disputes: [] };
    },
  };
}

function buildAuth(): AuthService {
  const store: AuthStore = {
    async findUserByPhone() {
      return null;
    },
    async findUserById(userId) {
      return userId === "authenticated-user"
        ? { id: userId, name: "Test User" }
        : null;
    },
    async createSession() {},
    async findActiveSession(hash, now) {
      if (hash !== tokenHash) return null;
      return {
        _id: "session-1",
        userId: "authenticated-user",
        tokenHash,
        createdAt: new Date(now.getTime() - 1_000),
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      };
    },
    async revokeSession() {},
  };
  return new AuthService(store);
}

test("allocates every cent deterministically across unique participants", () => {
  const shares = allocateShares(1001, ["user-c", "user-a", "user-b"]);
  assert.deepEqual(
    [...shares],
    [
      ["user-a", 334],
      ["user-b", 334],
      ["user-c", 333],
    ],
  );
  assert.deepEqual(
    [...allocateShares(1, ["user-c", "user-a", "user-b"])],
    [
      ["user-a", 1],
      ["user-b", 0],
      ["user-c", 0],
    ],
  );
  assert.deepEqual(
    [...allocateShares(1002, ["user-a", "user-b", "user-c"])],
    [
      ["user-a", 334],
      ["user-b", 334],
      ["user-c", 334],
    ],
  );
  assert.equal(
    [...shares.values()].reduce((sum, value) => sum + value, 0),
    1001,
  );
  assert.deepEqual([...allocateShares(5, ["same", "same"])], [["same", 5]]);
  assert.throws(() => allocateShares(-1, ["user"]), RangeError);
  assert.throws(
    () => allocateShares(Number.MAX_SAFE_INTEGER + 1, ["user"]),
    RangeError,
  );
});

test("offsets reciprocal balances by the lesser amount and preserves remainder", () => {
  assert.deepEqual(calculateOffset(12_345, 5_000), {
    amountCents: 5_000,
    firstRemainingCents: 7_345,
    secondRemainingCents: 0,
  });
  assert.deepEqual(calculateOffset(5_000, 5_000), {
    amountCents: 5_000,
    firstRemainingCents: 0,
    secondRemainingCents: 0,
  });
  assert.deepEqual(calculateOffset(5_000, 12_345), {
    amountCents: 5_000,
    firstRemainingCents: 0,
    secondRemainingCents: 7_345,
  });
  assert.throws(() => calculateOffset(0, 5_000), RangeError);
  assert.throws(() => calculateOffset(5_000, -1), RangeError);
  assert.throws(
    () => calculateOffset(Number.MAX_SAFE_INTEGER + 1, 1),
    RangeError,
  );
});

test("accepted disputes subtract only the disputed share", () => {
  assert.deepEqual(calculateDisputeResult(10_000, 2_345), {
    amountCents: 7_655,
    status: "pending",
  });
  assert.deepEqual(calculateDisputeResult(2_345, 2_345), {
    amountCents: 0,
    status: "contested",
  });
  assert.deepEqual(calculateDisputeResult(100, 1), {
    amountCents: 99,
    status: "pending",
  });
  assert.throws(() => calculateDisputeResult(100, 101), RangeError);
  assert.throws(() => calculateDisputeResult(100, 0), RangeError);
  assert.throws(
    () => calculateDisputeResult(100, Number.MAX_SAFE_INTEGER + 1),
    RangeError,
  );
});

test("rejects item writes attributed to a different buyer", () => {
  assert.throws(
    () =>
      validateNewItem(
        {
          date: "2026-10-03",
          market: "Market",
          product: "Product",
          valueCents: 500,
          buyerId: "another-user",
          participantIds: ["authenticated-user", "another-user"],
          paidDirectlyBy: [],
        },
        "authenticated-user",
      ),
    (error: unknown) =>
      error instanceof FinanceError &&
      error.statusCode === 403 &&
      error.code === "FORBIDDEN",
  );
});

test("protects all finance routes and uses only identity from bearer session", async () => {
  const calls: unknown[][] = [];
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    database: { async ping() {} },
    auth: buildAuth(),
    finance: buildFinanceApi(calls),
  });
  try {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/balances",
    });
    assert.equal(unauthorized.statusCode, 401);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap?month=2026-10",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(bootstrap.statusCode, 200);
    assert.deepEqual(calls[0], ["bootstrap", "authenticated-user", "2026-10"]);

    const invalidMonth = await app.inject({
      method: "GET",
      url: "/api/v1/items?month=not-a-month",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(invalidMonth.statusCode, 400);
    assert.equal(calls.length, 1);

    const noIdempotencyKey = await app.inject({
      method: "POST",
      url: "/api/v1/balances/balance-1/offset",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(noIdempotencyKey.statusCode, 400);
    assert.equal(calls.length, 1);

    const acceptedWrite = await app.inject({
      method: "POST",
      url: "/api/v1/items/batch",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "idempotency-key": "abcdefghijklmnop",
      },
      payload: {
        items: [
          {
            date: "2026-10-03",
            market: "Market",
            product: "Product",
            valueCents: 500,
            buyerId: "another-user",
            participantIds: ["authenticated-user", "another-user"],
            paidDirectlyBy: [],
          },
        ],
      },
    });
    assert.equal(acceptedWrite.statusCode, 201);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.[1], "authenticated-user");
  } finally {
    await app.close();
  }
});

test("passes the bearer identity to every finance route, ignoring supplied user IDs", async () => {
  const calls: unknown[][] = [];
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    database: { async ping() {} },
    auth: buildAuth(),
    finance: buildFinanceApi(calls),
  });
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "idempotency-key": "abcdefghijklmnop",
  };

  try {
    const requests = [
      {
        method: "GET",
        url: "/api/v1/bootstrap?month=2026-10&userId=other-user",
      },
      { method: "GET", url: "/api/v1/items?month=2026-10&userId=other-user" },
      { method: "GET", url: "/api/v1/balances?userId=other-user" },
      { method: "GET", url: "/api/v1/household/users?userId=other-user" },
      { method: "GET", url: "/api/v1/disputes?userId=other-user" },
      {
        method: "GET",
        url: "/api/v1/balances/other-balance/items?userId=other-user",
      },
      { method: "GET", url: "/api/v1/notifications?userId=other-user" },
      {
        method: "POST",
        url: "/api/v1/items/batch",
        payload: {
          items: [
            {
              date: "2026-10-03",
              market: "Market",
              product: "Product",
              valueCents: 500,
              participantIds: ["authenticated-user"],
              paidDirectlyBy: [],
            },
          ],
        },
      },
      {
        method: "POST",
        url: "/api/v1/balances/other-balance/payment-requests",
      },
      { method: "POST", url: "/api/v1/payment-requests/other-request/confirm" },
      {
        method: "POST",
        url: "/api/v1/balances/other-balance/disputes",
        payload: { itemId: "other-item" },
      },
      {
        method: "POST",
        url: "/api/v1/disputes/other-dispute/resolve",
        payload: { decision: "rejected" },
      },
      { method: "POST", url: "/api/v1/balances/other-balance/offset" },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers,
      });
      assert.ok(response.statusCode < 400, `${request.method} ${request.url}`);
    }

    assert.deepEqual(
      calls.map((call) => call[0]),
      [
        "bootstrap",
        "listItems",
        "getBalances",
        "getHouseholdUsers",
        "getDisputes",
        "getBalanceItems",
        "notifications",
        "saveItems",
        "requestPayment",
        "confirmPayment",
        "createDispute",
        "resolveDispute",
        "offsetBalance",
      ],
    );
    assert.ok(calls.every((call) => call[1] === "authenticated-user"));
  } finally {
    await app.close();
  }
});
