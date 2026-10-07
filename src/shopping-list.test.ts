import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AuthService, type AuthStore } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { ShoppingListApi } from "./shopping-list.js";

const accessToken = "s".repeat(43);
const tokenHash = createHash("sha256").update(accessToken).digest("hex");

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

test("protects shopping list operations and uses the authenticated author", async () => {
  const calls: unknown[][] = [];
  const shoppingList: ShoppingListApi = {
    async list() {
      calls.push(["list"]);
      return { items: [] };
    },
    async add(userId, product) {
      calls.push(["add", userId, product]);
      return { item: { id: "item-1", product, addedBy: userId } };
    },
    async remove(itemId) {
      calls.push(["remove", itemId]);
      return { success: true };
    },
  };
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    database: { async ping() {} },
    auth: buildAuth(),
    shoppingList,
  });
  const headers = { authorization: `Bearer ${accessToken}` };
  try {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/shopping-list",
    });
    assert.equal(unauthorized.statusCode, 401);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/shopping-list",
      headers,
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { items: [] });

    const add = await app.inject({
      method: "POST",
      url: "/api/v1/shopping-list",
      headers,
      payload: { product: "  Leite  " },
    });
    assert.equal(add.statusCode, 201);
    assert.deepEqual(calls[1], ["add", "authenticated-user", "  Leite  "]);

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/v1/shopping-list/item-1",
      headers,
    });
    assert.equal(remove.statusCode, 200);
    assert.deepEqual(calls[2], ["remove", "item-1"]);
  } finally {
    await app.close();
  }
});
