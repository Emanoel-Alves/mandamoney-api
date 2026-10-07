import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      async getProductMappings() {
        return [];
      },
      async saveProductMapping(product, categoryId) {
        return {
          product,
          normalizedProduct: product.toLocaleLowerCase("pt-BR"),
          categoryId,
          categoryName: category.name,
        };
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

    const mappings = await app.inject({
      method: "GET",
      url: "/api/v1/categories/product-mappings?products=arroz",
    });
    assert.equal(mappings.statusCode, 401);

    const saveMapping = await app.inject({
      method: "POST",
      url: "/api/v1/categories/product-mappings",
      payload: { product: "Arroz", categoryId: category._id },
    });
    assert.equal(saveMapping.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("looks up and saves product category mappings for authenticated users", async () => {
  const accessToken = "m".repeat(43);
  const tokenHash = createHash("sha256").update(accessToken).digest("hex");
  const category: CategoryDocument = {
    _id: "category-cereais",
    name: "Cereais",
    normalizedName: "cereais",
    color: "#d6a84f",
    createdAt: new Date("2026-10-03T12:00:00.000Z"),
    updatedAt: new Date("2026-10-03T12:00:00.000Z"),
  };
  const mappingLookups: string[][] = [];
  const authorizedAuth = new AuthService({
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
            _id: "test-session",
            userId: "test-user",
            tokenHash,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }
        : null;
    },
    async revokeSession() {},
  });
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    auth: authorizedAuth,
    database: { async ping() {} },
    categories: {
      async list() {
        return [category];
      },
      async create() {
        return category;
      },
      async getProductMappings(products) {
        mappingLookups.push(products);
        return [
          {
            product: "Café",
            normalizedProduct: "cafe",
            categoryId: category._id,
            categoryName: category.name,
          },
        ];
      },
      async saveProductMapping(product, categoryId) {
        assert.equal(product, "Arroz");
        assert.equal(categoryId, category._id);
        return {
          product,
          normalizedProduct: "arroz",
          categoryId,
          categoryName: category.name,
        };
      },
    },
  });

  try {
    const headers = { authorization: `Bearer ${accessToken}` };
    const lookup = await app.inject({
      method: "GET",
      url: "/api/v1/categories/product-mappings?products=CAF%C3%89&products=Arroz",
      headers,
    });
    assert.equal(lookup.statusCode, 200);
    assert.deepEqual(lookup.json(), {
      mappings: [
        {
          product: "Café",
          normalizedProduct: "cafe",
          categoryId: "category-cereais",
          categoryName: "Cereais",
        },
      ],
    });

    const singleLookup = await app.inject({
      method: "GET",
      url: "/api/v1/categories/product-mappings?products=Arroz",
      headers,
    });
    assert.equal(singleLookup.statusCode, 200);
    assert.deepEqual(mappingLookups, [["CAFÉ", "Arroz"], ["Arroz"]]);

    const save = await app.inject({
      method: "POST",
      url: "/api/v1/categories/product-mappings",
      headers,
      payload: { product: "Arroz", categoryId: category._id },
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().mapping.normalizedProduct, "arroz");
  } finally {
    await app.close();
  }
});
