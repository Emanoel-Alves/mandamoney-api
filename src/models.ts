import type { Db, IndexDescription } from "mongodb";

export type UserDocument = {
  _id: string;
  legacyId: string;
  name: string;
  phoneNormalized: string;
  legacyBirthdayVerifier?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ItemDocument = {
  _id: string;
  legacyId: string;
  buyerId: string;
  date: string;
  market: string;
  product: string;
  category: string;
  amountCents: number;
  participantIds: string[];
  paidDirectlyBy: string[];
  createdAt: Date;
};

export type ShoppingListItemDocument = {
  _id: string;
  product: string;
  addedBy: string;
  createdAt: Date;
};

export type CategoryDocument = {
  _id: string;
  name: string;
  normalizedName: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductCategoryMappingDocument = {
  _id: string;
  product: string;
  normalizedProduct: string;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type BalanceStatus =
  | "pending"
  | "awaiting_confirmation"
  | "contest_pending"
  | "paid"
  | "contested"
  | "offset";

export type BalanceDocument = {
  _id: string;
  legacyId: string;
  debtorId: string;
  creditorId: string;
  amountCents: number;
  status: BalanceStatus;
  paidAt: Date | null;
  updatedAt: Date;
};

export type BalanceItemDocument = {
  _id: string;
  balanceId: string;
  itemId: string;
  debtorId: string;
  creditorId: string;
  shareCents: number;
};

export type PaymentRequestDocument = {
  _id: string;
  legacyId: string | null;
  balanceId: string;
  debtorId: string;
  creditorId: string;
  amountCents: number;
  status: "pending" | "confirmed" | "rejected";
  requestedAt: Date;
  resolvedAt: Date | null;
};

export type DisputeDocument = {
  _id: string;
  legacyId: string | null;
  balanceId: string;
  itemId: string;
  debtorId: string;
  creditorId: string;
  amountCents: number;
  status: "pending" | "accepted" | "rejected";
  requestedAt: Date;
  resolvedAt: Date | null;
};

export type BalanceAdjustmentDocument = {
  _id: string;
  idempotencyKey: string;
  balanceIds: [string, string];
  actorId: string;
  amountCents: number;
  createdAt: Date;
};

export type IdempotencyDocument = {
  _id?: never;
  key: string;
  requestHash: string;
  response: unknown;
  expiresAt: Date;
};

export type SessionDocument = {
  _id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export const collectionNames = {
  users: "users",
  items: "items",
  balances: "balances",
  balanceItems: "balanceItems",
  paymentRequests: "paymentRequests",
  disputes: "disputes",
  balanceAdjustments: "balanceAdjustments",
  sessions: "sessions",
  idempotencyKeys: "idempotencyKeys",
  categories: "categories",
  productCategoryMappings: "productCategoryMappings",
  shoppingListItems: "shoppingListItems",
} as const;

export const indexes: Record<keyof typeof collectionNames, IndexDescription[]> =
  {
    users: [
      { key: { legacyId: 1 }, unique: true, name: "users_legacy_id_unique" },
      { key: { phoneNormalized: 1 }, unique: true, name: "users_phone_unique" },
    ],
    items: [
      { key: { legacyId: 1 }, unique: true, name: "items_legacy_id_unique" },
      { key: { date: -1, _id: -1 }, name: "items_date_id_desc" },
      { key: { buyerId: 1, date: -1 }, name: "items_buyer_date" },
      { key: { participantIds: 1, date: -1 }, name: "items_participant_date" },
    ],
    balances: [
      { key: { legacyId: 1 }, unique: true, name: "balances_legacy_id_unique" },
      {
        key: { debtorId: 1, creditorId: 1, status: 1 },
        name: "balances_pair_status",
      },
      { key: { debtorId: 1, status: 1 }, name: "balances_debtor_status" },
      { key: { creditorId: 1, status: 1 }, name: "balances_creditor_status" },
      {
        key: { debtorId: 1, creditorId: 1 },
        unique: true,
        partialFilterExpression: { status: "pending" },
        name: "balances_one_pending_per_pair",
      },
    ],
    balanceItems: [
      { key: { balanceId: 1, itemId: 1 }, name: "balance_items_balance_item" },
      { key: { itemId: 1 }, name: "balance_items_item" },
    ],
    paymentRequests: [
      {
        key: { legacyId: 1 },
        unique: true,
        sparse: true,
        name: "payment_legacy_id_unique",
      },
      {
        key: { creditorId: 1, status: 1, requestedAt: -1 },
        name: "payment_recipient_status_date",
      },
      { key: { balanceId: 1, status: 1 }, name: "payment_balance_status" },
    ],
    disputes: [
      {
        key: { legacyId: 1 },
        unique: true,
        sparse: true,
        name: "disputes_legacy_id_unique",
      },
      {
        key: { creditorId: 1, status: 1, requestedAt: -1 },
        name: "disputes_recipient_status_date",
      },
      {
        key: { balanceId: 1, itemId: 1 },
        unique: true,
        name: "disputes_balance_item_unique",
      },
    ],
    balanceAdjustments: [
      {
        key: { idempotencyKey: 1 },
        unique: true,
        name: "adjustments_idempotency_unique",
      },
      {
        key: { balanceIds: 1, createdAt: -1 },
        name: "adjustments_balance_date",
      },
    ],
    sessions: [
      {
        key: { tokenHash: 1 },
        unique: true,
        name: "sessions_token_hash_unique",
      },
      {
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        name: "sessions_expiry_ttl",
      },
      { key: { userId: 1, expiresAt: -1 }, name: "sessions_user_expiry" },
    ],
    idempotencyKeys: [
      { key: { key: 1 }, unique: true, name: "idempotency_key_unique" },
      {
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        name: "idempotency_expiry_ttl",
      },
    ],
    categories: [
      {
        key: { normalizedName: 1 },
        unique: true,
        name: "categories_normalized_name_unique",
      },
      { key: { name: 1 }, name: "categories_name" },
    ],
    productCategoryMappings: [
      {
        key: { normalizedProduct: 1 },
        unique: true,
        name: "product_category_mappings_product_unique",
      },
      { key: { categoryId: 1 }, name: "product_category_mappings_category" },
    ],
    shoppingListItems: [
      { key: { createdAt: -1, _id: -1 }, name: "shopping_list_created_desc" },
      { key: { addedBy: 1, createdAt: -1 }, name: "shopping_list_added_by" },
    ],
  };

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.entries(collectionNames).map(async ([key, collectionName]) => {
      const definitions = indexes[key as keyof typeof collectionNames];
      await db.collection(collectionName).createIndexes(definitions);
    }),
  );
}
