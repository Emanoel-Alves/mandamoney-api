import assert from "node:assert/strict";
import test from "node:test";
import { CategoryService, createLegacyCategory } from "./categories.js";
import type { CategoryDocument } from "./models.js";

class MemoryCategoryStore {
  readonly categories = new Map<string, CategoryDocument>();

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
