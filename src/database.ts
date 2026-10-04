import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoClientOptions,
} from "mongodb";
import type { AppConfig } from "./config.js";

const options: MongoClientOptions = {
  appName: "mandamoney-api",
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 30_000,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 5_000,
  retryWrites: true,
};

export class Database {
  private client: MongoClient | undefined;
  private db: Db | undefined;
  private connecting: Promise<Db> | undefined;

  constructor(
    private readonly uri: string,
    private readonly databaseName: string,
  ) {
    if (!uri) throw new Error("MongoDB connection URI must not be empty.");
  }

  async connect(): Promise<Db> {
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;

    this.connecting = this.open();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async ping(): Promise<void> {
    const db = await this.connect();
    await db.command({ ping: 1 });
  }

  async assertTransactionsSupported(): Promise<void> {
    const db = await this.connect();
    const topology: unknown = await db.admin().command({ hello: 1 });
    const supportsTransactions =
      typeof topology === "object" &&
      topology !== null &&
      (("setName" in topology && typeof topology.setName === "string") ||
        ("msg" in topology && topology.msg === "isdbgrid"));
    if (!supportsTransactions) {
      throw new Error(
        "MongoDB must be a replica set or sharded cluster to support atomic finance transactions.",
      );
    }
  }

  async withTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await this.connect();
    if (!this.client) {
      throw new Error("MongoDB client is not connected.");
    }

    const session = this.client.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await operation(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.db = undefined;
    this.connecting = undefined;
    if (client) await client.close();
  }

  private async open(): Promise<Db> {
    const client = new MongoClient(this.uri, options);
    try {
      await client.connect();
      const db = client.db(this.databaseName);
      await db.command({ ping: 1 });
      this.client = client;
      this.db = db;
      return db;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

export function createDatabase(config: AppConfig): Database {
  return new Database(config.mongoUri, config.mongoDatabase);
}
