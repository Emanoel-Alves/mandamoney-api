import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { CategoryDocument } from "./models.js";

const auth = new AuthService({
  async findUserByPhone() {
    return null;
  },
  async findUserById() {
    return null;
  },
  async createSession() {},
  async findActiveSession() {
    return null;
  },
  async revokeSession() {},
});

test("serves liveness and returns unavailable readiness when database ping fails", async () => {
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    auth,
    database: {
      async ping() {
        throw new Error("database offline");
      },
    },
  });

  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: "ok" });

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), {
      error: { code: "SERVICE_UNAVAILABLE", message: "Service is not ready." },
    });
  } finally {
    await app.close();
  }
});

test("does not allow cross-origin calls from untrusted origins", async () => {
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    auth,
    database: { async ping() {} },
  });
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health/live",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("serves database categories publicly and protects category creation", async () => {
  const category: CategoryDocument = {
    _id: "category-cereais",
    name: "Cereais",
    normalizedName: "cereais",
    color: "#d6a84f",
    createdAt: new Date("2026-10-03T12:00:00.000Z"),
    updatedAt: new Date("2026-10-03T12:00:00.000Z"),
  };
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    auth,
    database: { async ping() {} },
    categories: {
      async list() {
        return [category];
      },
      async create() {
        return category;
      },
    },
  });

  try {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/categories",
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), {
      categories: [
        { id: "category-cereais", name: "Cereais", color: "#d6a84f" },
      ],
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/categories",
      payload: { name: "Nova categoria" },
    });
    assert.equal(create.statusCode, 401);
  } finally {
    await app.close();
  }
});
