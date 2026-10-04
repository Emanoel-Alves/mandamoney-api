import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthService } from "./auth.js";
import { requireAuthentication } from "./auth.js";
import type { Database } from "./database.js";
import { collectionNames, type CategoryDocument } from "./models.js";

const categoryColors = [
  "#d96c55",
  "#d6a84f",
  "#6ca66b",
  "#7197b7",
  "#9a7bb5",
  "#a99f92",
  "#d887a4",
  "#55a6a6",
] as const;

const legacyCategoryColors: Record<string, string> = {
  alimenticios: "#9a7bb5",
  carnes: "#d96c55",
  cereais: "#d6a84f",
  higiene: "#7197b7",
  hortalicas: "#6ca66b",
  outros: "#a99f92",
};

export type CategoryApi = Pick<CategoryService, "list" | "create">;

export interface CategoryStore {
  list(): Promise<CategoryDocument[]>;
  upsert(category: CategoryDocument): Promise<CategoryDocument>;
}

export class CategoryError extends Error {
  readonly statusCode = 400;
  readonly code = "INVALID_CATEGORY";

  constructor(message: string) {
    super(message);
    this.name = "CategoryError";
  }
}

export class MongoCategoryStore implements CategoryStore {
  constructor(private readonly database: Database) {}

  async list(): Promise<CategoryDocument[]> {
    const db = await this.database.connect();
    return db
      .collection<CategoryDocument>(collectionNames.categories)
      .find({})
      .sort({ name: 1, _id: 1 })
      .toArray();
  }

  async upsert(category: CategoryDocument): Promise<CategoryDocument> {
    const db = await this.database.connect();
    const collection = db.collection<CategoryDocument>(
      collectionNames.categories,
    );
    await collection.updateOne(
      { _id: category._id },
      { $setOnInsert: category },
      { upsert: true },
    );
    const existing = await collection.findOne({ _id: category._id });
    if (!existing)
      throw new Error("Category upsert did not return a document.");
    return existing;
  }
}

export class CategoryService {
  constructor(
    private readonly store: CategoryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<CategoryDocument[]> {
    return this.store.list();
  }

  async create(name: string): Promise<CategoryDocument> {
    const trimmedName = name.trim();
    const normalizedName = normalizeCategoryName(trimmedName);
    if (!normalizedName) {
      throw new CategoryError("Category name must contain letters or numbers.");
    }
    const now = this.now();
    return this.store.upsert({
      _id: `category-${normalizedName}`,
      name: trimmedName,
      normalizedName,
      color: categoryColor(trimmedName),
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function createLegacyCategory(
  name: string,
  createdAt = new Date(),
): CategoryDocument {
  const trimmedName = name.trim();
  const normalizedName = normalizeCategoryName(trimmedName);
  if (!normalizedName) {
    throw new CategoryError(
      "Legacy category name must contain letters or numbers.",
    );
  }
  return {
    _id: `category-${normalizedName}`,
    name: trimmedName,
    normalizedName,
    color: legacyCategoryColors[normalizedName] ?? categoryColor(trimmedName),
    createdAt,
    updatedAt: createdAt,
  };
}

export function registerCategoryRoutes(
  app: FastifyInstance,
  categories: CategoryApi,
  auth: AuthService,
): void {
  app.get("/api/v1/categories", async () => ({
    categories: (await categories.list()).map(serializeCategory),
  }));

  app.post<{ Body: { name: string } }>(
    "/api/v1/categories",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (request, reply) => {
      const category = await categories.create(request.body.name);
      return reply.code(200).send({ category: serializeCategory(category) });
    },
  );
}

export function serializeCategory(category: CategoryDocument) {
  return {
    id: category._id,
    name: category.name,
    color: category.color,
  };
}

export function normalizeCategoryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function categoryColor(name: string): string {
  const hash = createHash("sha256")
    .update(normalizeCategoryName(name))
    .digest();
  return categoryColors[hash[0]! % categoryColors.length]!;
}
