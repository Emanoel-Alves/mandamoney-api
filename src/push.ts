import webPush from "web-push";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Database } from "./database.js";
import { requireAuthentication, type AuthService } from "./auth.js";
import { collectionNames, type PushSubscriptionDocument } from "./models.js";

export type PushMessage = {
  title: string;
  body: string;
  tag: string;
};

export type PushNotificationSender = {
  sendToUser(userId: string, message: PushMessage): Promise<void>;
};

export type PushApi = PushNotificationSender & {
  getPublicKey(): { publicKey: string | null };
  saveSubscription(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<{ enabled: true }>;
  removeSubscription(
    userId: string,
    endpoint: string,
  ): Promise<{ removed: boolean }>;
};

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export class PushError extends Error {
  constructor(
    readonly statusCode: 400 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

export class PushNotificationService implements PushNotificationSender {
  private readonly configured: boolean;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {
    this.configured = Boolean(
      config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject,
    );
    if (
      config.vapidPublicKey &&
      config.vapidPrivateKey &&
      config.vapidSubject
    ) {
      webPush.setVapidDetails(
        config.vapidSubject,
        config.vapidPublicKey,
        config.vapidPrivateKey,
      );
    }
  }

  getPublicKey(): { publicKey: string | null } {
    return { publicKey: this.config.vapidPublicKey ?? null };
  }

  async saveSubscription(
    userId: string,
    subscription: PushSubscriptionInput,
  ): Promise<{ enabled: true }> {
    if (!this.configured) {
      throw new PushError(
        503,
        "PUSH_NOT_CONFIGURED",
        "Push notifications are not configured on the server.",
      );
    }
    validatePushEndpoint(subscription.endpoint);

    const now = new Date();
    const db = await this.database.connect();
    await db
      .collection<PushSubscriptionDocument>(collectionNames.pushSubscriptions)
      .updateOne(
        { endpoint: subscription.endpoint },
        {
          $set: {
            userId,
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    return { enabled: true };
  }

  async removeSubscription(
    userId: string,
    endpoint: string,
  ): Promise<{ removed: boolean }> {
    const db = await this.database.connect();
    const result = await db
      .collection<PushSubscriptionDocument>(collectionNames.pushSubscriptions)
      .deleteOne({ userId, endpoint });
    return { removed: result.deletedCount > 0 };
  }

  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    if (!this.configured) return;
    const db = await this.database.connect();
    const subscriptions = await db
      .collection<PushSubscriptionDocument>(collectionNames.pushSubscriptions)
      .find({ userId })
      .toArray();
    const failures: Error[] = [];

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            JSON.stringify({ ...message, url: "./" }),
          );
        } catch (error) {
          const statusCode =
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
              ? error.statusCode
              : undefined;
          if (statusCode === 404 || statusCode === 410) {
            await db
              .collection<PushSubscriptionDocument>(
                collectionNames.pushSubscriptions,
              )
              .deleteOne({
                userId,
                endpoint: subscription.endpoint,
              });
            return;
          }
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }),
    );

    if (failures.length) {
      throw new AggregateError(
        failures,
        "One or more push notifications could not be delivered.",
      );
    }
  }
}

export function validatePushEndpoint(
  value: string,
  allowedHosts = new Set([
    "fcm.googleapis.com",
    "web.push.apple.com",
    "push.services.mozilla.com",
    "updates.push.services.mozilla.com",
  ]),
): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new PushError(400, "INVALID_REQUEST", "Invalid push endpoint.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.port && endpoint.port !== "443") ||
    !allowedHosts.has(endpoint.hostname.toLowerCase())
  ) {
    throw new PushError(
      400,
      "INVALID_REQUEST",
      "Push endpoint must use a supported browser push service.",
    );
  }
}

export function registerPushRoutes(
  app: FastifyInstance,
  push: PushApi,
  auth: AuthService,
): void {
  app.get("/api/v1/push/public-key", async () => push.getPublicKey());

  app.post<{ Body: PushSubscriptionInput }>(
    "/api/v1/push/subscriptions",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["endpoint", "keys"],
          additionalProperties: false,
          properties: {
            endpoint: { type: "string", minLength: 1, maxLength: 2048 },
            expirationTime: { type: ["number", "null"] },
            keys: {
              type: "object",
              required: ["p256dh", "auth"],
              additionalProperties: false,
              properties: {
                p256dh: { type: "string", minLength: 1, maxLength: 256 },
                auth: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
        },
      },
    },
    async (request) =>
      push.saveSubscription(request.authUser!.id, request.body),
  );

  app.delete<{ Body: { endpoint: string } }>(
    "/api/v1/push/subscriptions",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["endpoint"],
          additionalProperties: false,
          properties: {
            endpoint: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (request) =>
      push.removeSubscription(request.authUser!.id, request.body.endpoint),
  );
}
