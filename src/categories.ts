import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthService } from "./auth.js";
import { requireAuthentication } from "./auth.js";
import type { Database } from "./database.js";
import {
  collectionNames,
  type CategoryDocument,
  type ProductCategoryMappingDocument,
} from "./models.js";

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

export type ProductCategoryMapping = {
  product: string;
  normalizedProduct: string;
  categoryId: string;
  categoryName: string;
};

export type CategoryApi = Pick<
  CategoryService,
  "list" | "create" | "getProductMappings" | "saveProductMapping"
>;

export interface CategoryStore {
  list(): Promise<CategoryDocument[]>;
  upsert(category: CategoryDocument): Promise<CategoryDocument>;
  findById(id: string): Promise<CategoryDocument | null>;
  listProductMappings(
    normalizedProducts: string[],
  ): Promise<ProductCategoryMappingDocument[]>;
  upsertProductMapping(
    mapping: ProductCategoryMappingDocument,
  ): Promise<ProductCategoryMappingDocument>;
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

  async findById(id: string): Promise<CategoryDocument | null> {
    const db = await this.database.connect();
    return db
      .collection<CategoryDocument>(collectionNames.categories)
      .findOne({ _id: id });
  }

  async listProductMappings(
    normalizedProducts: string[],
  ): Promise<ProductCategoryMappingDocument[]> {
    const db = await this.database.connect();
    return db
      .collection<ProductCategoryMappingDocument>(
        collectionNames.productCategoryMappings,
      )
      .find({ normalizedProduct: { $in: normalizedProducts } })
      .toArray();
  }

  async upsertProductMapping(
    mapping: ProductCategoryMappingDocument,
  ): Promise<ProductCategoryMappingDocument> {
    const db = await this.database.connect();
    const collection = db.collection<ProductCategoryMappingDocument>(
      collectionNames.productCategoryMappings,
    );
    await collection.updateOne(
      { _id: mapping._id },
      {
        $set: {
          product: mapping.product,
          normalizedProduct: mapping.normalizedProduct,
          categoryId: mapping.categoryId,
          updatedAt: mapping.updatedAt,
        },
        $setOnInsert: { createdAt: mapping.createdAt },
      },
      { upsert: true },
    );
    const saved = await collection.findOne({ _id: mapping._id });
    if (!saved) {
      throw new Error(
        "Product category mapping upsert did not return a document.",
      );
    }
    return saved;
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

  async getProductMappings(
    products: string[],
  ): Promise<ProductCategoryMapping[]> {
    const normalizedProducts = [
      ...new Set(products.map(normalizeProductName).filter(Boolean)),
    ];
    if (normalizedProducts.length === 0) return [];

    const mappings = await this.store.listProductMappings(normalizedProducts);
    if (mappings.length === 0) return [];
    const categories = await this.store.list();
    const categoriesById = new Map(
      categories.map((category) => [category._id, category]),
    );
    return mappings.flatMap((mapping) => {
      const category = categoriesById.get(mapping.categoryId);
      return category
        ? [
            {
              product: mapping.product,
              normalizedProduct: mapping.normalizedProduct,
              categoryId: category._id,
              categoryName: category.name,
            },
          ]
        : [];
    });
  }

  async saveProductMapping(
    product: string,
    categoryId: string,
  ): Promise<ProductCategoryMapping> {
    const trimmedProduct = product.trim();
    const normalizedProduct = normalizeProductName(trimmedProduct);
    if (!normalizedProduct || trimmedProduct.length > 300) {
      throw new CategoryError("Product name must contain 1 to 300 characters.");
    }
    const category = await this.store.findById(categoryId);
    if (!category) {
      throw new CategoryError("Selected category does not exist.");
    }
    const now = this.now();
    const mapping = await this.store.upsertProductMapping({
      _id: normalizedProduct,
      product: trimmedProduct,
      normalizedProduct,
      categoryId: category._id,
      createdAt: now,
      updatedAt: now,
    });
    return {
      product: mapping.product,
      normalizedProduct: mapping.normalizedProduct,
      categoryId: category._id,
      categoryName: category.name,
    };
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

  app.get<{ Querystring: { products: string[] } }>(
    "/api/v1/categories/product-mappings",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        querystring: {
          type: "object",
          required: ["products"],
          additionalProperties: false,
          properties: {
            products: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
          },
        },
      },
    },
    async (request) => ({
      mappings: await categories.getProductMappings(request.query.products),
    }),
  );

  app.post<{
    Body: { product: string; categoryId: string };
  }>(
    "/api/v1/categories/product-mappings",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["product", "categoryId"],
          additionalProperties: false,
          properties: {
            product: { type: "string", minLength: 1, maxLength: 300 },
            categoryId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request) => ({
      mapping: await categories.saveProductMapping(
        request.body.product,
        request.body.categoryId,
      ),
    }),
  );

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

export function normalizeProductName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function categoryColor(name: string): string {
  const hash = createHash("sha256")
    .update(normalizeCategoryName(name))
    .digest();
  return categoryColors[hash[0]! % categoryColors.length]!;
}
