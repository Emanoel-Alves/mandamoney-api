import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { AuthService, registerAuthRoutes } from "./auth.js";
import {
  CategoryError,
  registerCategoryRoutes,
  type CategoryApi,
} from "./categories.js";
import {
  FinanceError,
  type FinanceApi,
  registerFinanceRoutes,
} from "./finance.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./database.js";
import {
  ProviderError,
  ReceiptImportService,
  registerImportRoutes,
} from "./integrations.js";
import {
  registerShoppingListRoutes,
  ShoppingListError,
  type ShoppingListApi,
} from "./shopping-list.js";

export interface DatabaseHealth {
  ping(): Promise<void>;
}

export type AppDependencies = {
  config: AppConfig;
  database: DatabaseHealth;
  auth: AuthService;
  finance?: FinanceApi;
  categories?: CategoryApi;
  imports?: ReceiptImportService;
  shoppingList?: ShoppingListApi;
};

export async function buildApp({
  config,
  database,
  auth,
  finance,
  categories,
  imports,
  shoppingList,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 1_048_576,
    trustProxy: config.trustProxy,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["set-cookie"]',
          "req.body.phone",
          "req.body.birthday",
          "req.body.token",
          "req.body.qrCode",
          "req.body.imageBase64",
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
    },
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS."), false);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    max: config.nodeEnv === "test" ? 1000 : 120,
    timeWindow: "1 minute",
    hook: "onRequest",
  });

  app.decorateRequest("authUser", null);
  app.decorateRequest("authToken", null);
  registerAuthRoutes(app, auth);
  if (finance) registerFinanceRoutes(app, finance, auth);
  if (categories) registerCategoryRoutes(app, categories, auth);
  if (imports) registerImportRoutes(app, imports, auth);
  if (shoppingList) registerShoppingListRoutes(app, shoppingList, auth);

  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string", const: "ok" } },
            required: ["status"],
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  app.get("/health/ready", async (request, reply) => {
    try {
      await database.ping();
      return { status: "ready" };
    } catch (error) {
      request.log.error({ err: error }, "Database readiness check failed");
      return reply.code(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Service is not ready.",
        },
      });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CategoryError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof FinanceError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof ShoppingListError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof ProviderError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof Error && "validation" in error && error.validation) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed.",
        },
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests." },
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 413
    ) {
      return reply.code(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body exceeds the supported size.",
        },
      });
    }
    app.log.error({ err: error }, "Unhandled API error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  });

  return app;
}
