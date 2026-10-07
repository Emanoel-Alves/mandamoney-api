import assert from "node:assert/strict";
import test from "node:test";
import {
  CategoryService,
  createLegacyCategory,
  normalizeProductName,
} from "./categories.js";
import type {
  CategoryDocument,
  ProductCategoryMappingDocument,
} from "./models.js";

class MemoryCategoryStore {
  readonly categories = new Map<string, CategoryDocument>();
  readonly productMappings = new Map<string, ProductCategoryMappingDocument>();

  async list(): Promise<CategoryDocument[]> {
    return [...this.categories.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    );
  }

  async upsert(category: CategoryDocument): Promise<CategoryDocument> {
    const existing = this.categories.get(category._id);
    if (existing) return existing;
    this.categories.set(category._id, category);
    return category;
  }

  async findById(id: string): Promise<CategoryDocument | null> {
    return this.categories.get(id) ?? null;
  }

  async listProductMappings(
    normalizedProducts: string[],
  ): Promise<ProductCategoryMappingDocument[]> {
    return normalizedProducts.flatMap((product) => {
      const mapping = this.productMappings.get(product);
      return mapping ? [mapping] : [];
    });
  }

  async upsertProductMapping(
    mapping: ProductCategoryMappingDocument,
  ): Promise<ProductCategoryMappingDocument> {
    const existing = this.productMappings.get(mapping.normalizedProduct);
    const saved = existing
      ? { ...mapping, createdAt: existing.createdAt }
      : mapping;
    this.productMappings.set(mapping.normalizedProduct, saved);
    return saved;
  }
}

test("creates normalized categories idempotently with a persistent color", async () => {
  const store = new MemoryCategoryStore();
  const createdAt = new Date("2026-10-03T12:00:00.000Z");
  const service = new CategoryService(store, () => createdAt);
  const first = await service.create("  Hortaliças  ");
  const replay = await service.create("Hortalicas");

  assert.equal(first._id, "category-hortalicas");
  assert.equal(first.normalizedName, "hortalicas");
  assert.equal(first.name, "Hortaliças");
  assert.equal(first.color, "#6ca66b");
  assert.deepEqual(replay, first);
  assert.equal((await service.list()).length, 1);
});

test("preserves legacy category colors while seeding from imported data", () => {
  const category = createLegacyCategory(
    "Cereais",
    new Date("2026-10-03T12:00:00.000Z"),
  );
  assert.equal(category._id, "category-cereais");
  assert.equal(category.color, "#d6a84f");
});

test("rejects names that normalize to an empty category ID", async () => {
  const service = new CategoryService(new MemoryCategoryStore());
  await assert.rejects(
    service.create("---"),
    /must contain letters or numbers/,
  );
});

test("normalizes product names for persistent category mappings", () => {
  assert.equal(normalizeProductName("  CAFÉ  Pilão  "), "cafe pilao");
  assert.equal(normalizeProductName("LEITE-INTEGRAL 1L"), "leite integral 1l");
});

test("saves and reads a product category mapping from the database store", async () => {
  const store = new MemoryCategoryStore();
  const service = new CategoryService(
    store,
    () => new Date("2026-10-06T12:00:00.000Z"),
  );
  const category = await service.create("Laticínios");
  const saved = await service.saveProductMapping(
    "  Leite Integral  ",
    category._id,
  );

  assert.deepEqual(saved, {
    product: "Leite Integral",
    normalizedProduct: "leite integral",
    categoryId: category._id,
    categoryName: "Laticínios",
  });
  assert.deepEqual(
    await service.getProductMappings(["LEITE INTEGRAL", "Arroz"]),
    [saved],
  );
});

test("updates an existing product mapping when the selected category changes", async () => {
  const store = new MemoryCategoryStore();
  const service = new CategoryService(store);
  const cereals = await service.create("Cereais");
  const produce = await service.create("Hortaliças");
  await service.saveProductMapping("Tomate", cereals._id);
  const updated = await service.saveProductMapping("TOMATE", produce._id);

  assert.equal(updated.categoryId, produce._id);
  assert.equal(updated.categoryName, "Hortaliças");
  assert.equal(store.productMappings.size, 1);
});

test("rejects product mappings to nonexistent categories", async () => {
  const service = new CategoryService(new MemoryCategoryStore());
  await assert.rejects(
    service.saveProductMapping("Produto", "missing-category"),
    /Selected category does not exist/,
  );
});
