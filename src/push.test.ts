import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import {
  PushError,
  validatePushEndpoint,
  type PushApi,
  type PushSubscriptionInput,
} from "./push.js";

const accessToken = "p".repeat(43);
const tokenHash = createHash("sha256").update(accessToken).digest("hex");

function buildAuth(): AuthService {
  return new AuthService({
    async findUserByPhone() {
      return null;
    },
    async findUserById(id) {
      return { id, name: "Test User" };
    },
    async createSession() {},
    async findActiveSession(hash) {
      return hash === tokenHash
        ? {
            _id: "push-test-session",
            userId: "push-test-user",
            tokenHash,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }
        : null;
    },
    async revokeSession() {},
  });
}

test("publishes only the public key and protects device subscription management", async () => {
  const savedSubscriptions: Array<{
    userId: string;
    subscription: PushSubscriptionInput;
  }> = [];
  const removedSubscriptions: Array<{ userId: string; endpoint: string }> = [];
  const push: PushApi = {
    getPublicKey: () => ({ publicKey: "test-public-key" }),
    async saveSubscription(userId, subscription) {
      savedSubscriptions.push({ userId, subscription });
      return { enabled: true };
    },
    async removeSubscription(userId, endpoint) {
      removedSubscriptions.push({ userId, endpoint });
      return { removed: true };
    },
    async sendToUser() {},
  };
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    auth: buildAuth(),
    database: { async ping() {} },
    push,
  });

  try {
    const publicKey = await app.inject({
      method: "GET",
      url: "/api/v1/push/public-key",
    });
    assert.equal(publicKey.statusCode, 200);
    assert.deepEqual(publicKey.json(), { publicKey: "test-public-key" });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      payload: {
        endpoint: "https://fcm.googleapis.com/push/token",
        keys: { p256dh: "key", auth: "secret" },
      },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const subscription: PushSubscriptionInput = {
      endpoint: "https://fcm.googleapis.com/push/token",
      expirationTime: null,
      keys: { p256dh: "public-key", auth: "auth-secret" },
    };
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: subscription,
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(savedSubscriptions, [
      { userId: "push-test-user", subscription },
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/push/subscriptions",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { endpoint: subscription.endpoint },
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removedSubscriptions, [
      { userId: "push-test-user", endpoint: subscription.endpoint },
    ]);
  } finally {
    await app.close();
  }
});

test("accepts only HTTPS endpoints from browser push services", () => {
  for (const endpoint of [
    "https://example.com/push/token",
    "http://fcm.googleapis.com/push/token",
    "https://user@fcm.googleapis.com/push/token",
    "https://fcm.googleapis.com:444/push/token",
  ]) {
    assert.throws(
      () => validatePushEndpoint(endpoint),
      (error) =>
        error instanceof PushError &&
        error.statusCode === 400 &&
        error.code === "INVALID_REQUEST",
    );
  }
  assert.doesNotThrow(() =>
    validatePushEndpoint("https://web.push.apple.com/push/token"),
  );
});
