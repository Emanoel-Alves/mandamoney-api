import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "./database.js";
import { requireAuthentication, type AuthService } from "./auth.js";
import {
  collectionNames,
  type ShoppingListItemDocument,
  type UserDocument,
} from "./models.js";

export class ShoppingListError extends Error {
  constructor(
    readonly statusCode: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShoppingListError";
  }
}

export class ShoppingListService {
  constructor(private readonly database: Database) {}

  async list(): Promise<unknown> {
    const db = await this.database.connect();
    const [items, users] = await Promise.all([
      db
        .collection<ShoppingListItemDocument>(collectionNames.shoppingListItems)
        .find({})
        .sort({ createdAt: -1, _id: -1 })
        .toArray(),
      db
        .collection<UserDocument>(collectionNames.users)
        .find({}, { projection: { _id: 1, name: 1 } })
        .toArray(),
    ]);
    const names = new Map(users.map((user) => [user._id, user.name]));
    return {
      items: items.map((item) => ({
        id: item._id,
        product: item.product,
        addedBy: item.addedBy,
        addedByName: names.get(item.addedBy) ?? "",
        createdAt: item.createdAt,
      })),
    };
  }

  async add(userId: string, product: string): Promise<unknown> {
    const normalizedProduct = product.trim();
    if (!normalizedProduct || normalizedProduct.length > 300) {
      throw new ShoppingListError(
        400,
        "INVALID_REQUEST",
        "Shopping list item must contain between 1 and 300 characters.",
      );
    }
    const db = await this.database.connect();
    const user = await db
      .collection<UserDocument>(collectionNames.users)
      .findOne({ _id: userId }, { projection: { _id: 1, name: 1 } });
    if (!user) {
      throw new ShoppingListError(404, "NOT_FOUND", "User not found.");
    }
    const item: ShoppingListItemDocument = {
      _id: randomUUID(),
      product: normalizedProduct,
      addedBy: userId,
      createdAt: new Date(),
    };
    await db
      .collection<ShoppingListItemDocument>(collectionNames.shoppingListItems)
      .insertOne(item);
    return {
      item: {
        id: item._id,
        product: item.product,
        addedBy: item.addedBy,
        addedByName: user.name,
        createdAt: item.createdAt,
      },
    };
  }

  async remove(itemId: string): Promise<unknown> {
    const db = await this.database.connect();
    const result = await db
      .collection<ShoppingListItemDocument>(collectionNames.shoppingListItems)
      .deleteOne({ _id: itemId });
    if (!result.deletedCount) {
      throw new ShoppingListError(
        404,
        "NOT_FOUND",
        "Shopping list item not found.",
      );
    }
    return { success: true };
  }
}

export type ShoppingListApi = Pick<
  ShoppingListService,
  "list" | "add" | "remove"
>;

export function registerShoppingListRoutes(
  app: FastifyInstance,
  shoppingList: ShoppingListApi,
  auth: AuthService,
): void {
  app.get(
    "/api/v1/shopping-list",
    { preHandler: requireAuthentication(auth) },
    async () => shoppingList.list(),
  );

  app.post<{ Body: { product: string } }>(
    "/api/v1/shopping-list",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["product"],
          additionalProperties: false,
          properties: {
            product: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await shoppingList.add(request.authUser!.id, request.body.product),
        ),
  );

  app.delete<{ Params: { itemId: string } }>(
    "/api/v1/shopping-list/:itemId",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        params: {
          type: "object",
          required: ["itemId"],
          properties: {
            itemId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request) => shoppingList.remove(request.params.itemId),
  );
}
