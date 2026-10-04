import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./database.js";
import {
  collectionNames,
  type SessionDocument,
  type UserDocument,
} from "./models.js";

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type AuthenticatedUser = { id: string; name: string };
export type IssuedSession = {
  accessToken: string;
  expiresAt: string;
  user: AuthenticatedUser;
};

type UserAuthRecord = Pick<UserDocument, "_id" | "name"> &
  Partial<Pick<UserDocument, "legacyBirthdayVerifier">>;

export interface AuthStore {
  findUserByPhone(phoneNormalized: string): Promise<UserAuthRecord | null>;
  findUserById(userId: string): Promise<AuthenticatedUser | null>;
  createSession(session: SessionDocument): Promise<void>;
  findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<SessionDocument | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

export class MongoAuthStore implements AuthStore {
  constructor(private readonly database: Database) {}

  async findUserByPhone(
    phoneNormalized: string,
  ): Promise<UserAuthRecord | null> {
    const db = await this.database.connect();
    const user = await db
      .collection<UserDocument>(collectionNames.users)
      .findOne(
        { phoneNormalized },
        { projection: { _id: 1, name: 1, legacyBirthdayVerifier: 1 } },
      );
    return user;
  }

  async findUserById(userId: string): Promise<AuthenticatedUser | null> {
    const db = await this.database.connect();
    const user = await db
      .collection<UserDocument>(collectionNames.users)
      .findOne({ _id: userId }, { projection: { _id: 1, name: 1 } });
    return user ? { id: user._id, name: user.name } : null;
  }

  async createSession(session: SessionDocument): Promise<void> {
    const db = await this.database.connect();
    await db
      .collection<SessionDocument>(collectionNames.sessions)
      .insertOne(session);
  }

  async findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<SessionDocument | null> {
    const db = await this.database.connect();
    return db.collection<SessionDocument>(collectionNames.sessions).findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now },
    });
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    const db = await this.database.connect();
    await db
      .collection<SessionDocument>(collectionNames.sessions)
      .updateOne({ tokenHash, revokedAt: null }, { $set: { revokedAt: now } });
  }
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly legacyAuthPepper?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(
    phone: string,
    birthday: string,
  ): Promise<IssuedSession | null | "disabled"> {
    if (!this.legacyAuthPepper) return "disabled";

    const phoneNormalized = normalizePhone(phone);
    const birthdayCanonical = canonicalizeBirthday(birthday);
    if (!phoneNormalized || !birthdayCanonical) return null;

    const user = phoneNormalized
      ? await this.store.findUserByPhone(phoneNormalized)
      : null;
    const expectedVerifier = computeLegacyBirthdayVerifier(
      this.legacyAuthPepper,
      user?._id ?? "unknown-account",
      birthdayCanonical,
    );
    const suppliedVerifier = user?.legacyBirthdayVerifier ?? "0".repeat(64);
    const validProof = safeHexEqual(suppliedVerifier, expectedVerifier);
    if (!user || !validProof) return null;

    return this.issueSession({ id: user._id, name: user.name });
  }

  async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken)) return null;
    const session = await this.store.findActiveSession(
      hashToken(accessToken),
      this.now(),
    );
    return session ? this.store.findUserById(session.userId) : null;
  }

  async logout(accessToken: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken)) return;
    await this.store.revokeSession(hashToken(accessToken), this.now());
  }

  private async issueSession(user: AuthenticatedUser): Promise<IssuedSession> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
    const accessToken = randomBytes(32).toString("base64url");
    await this.store.createSession({
      _id: randomBytes(16).toString("hex"),
      userId: user.id,
      tokenHash: hashToken(accessToken),
      createdAt: now,
      expiresAt,
      revokedAt: null,
    });
    return { accessToken, expiresAt: expiresAt.toISOString(), user };
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
): void {
  app.post<{ Body: { phone: string; birthday: string } }>(
    "/api/v1/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          required: ["phone", "birthday"],
          additionalProperties: false,
          properties: {
            phone: { type: "string", minLength: 10, maxLength: 20 },
            birthday: { type: "string", pattern: "^\\d{2}/\\d{2}/\\d{4}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await auth.login(
        request.body.phone,
        request.body.birthday,
      );
      if (session === "disabled") {
        return reply.code(503).send({
          error: {
            code: "AUTH_NOT_CONFIGURED",
            message:
              "Legacy phone-and-birthday authentication is not configured.",
          },
        });
      }
      if (!session) {
        return reply.code(401).send({
          error: { code: "UNAUTHORIZED", message: "Invalid credentials." },
        });
      }
      return reply.code(200).send(session);
    },
  );

  app.get(
    "/api/v1/auth/me",
    { preHandler: requireAuthentication(auth) },
    async (request, reply) => {
      if (!request.authUser) {
        return reply.code(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication is required.",
          },
        });
      }
      return { user: request.authUser };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    { preHandler: requireAuthentication(auth) },
    async (request, reply) => {
      if (!request.authToken) {
        return reply.code(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication is required.",
          },
        });
      }
      await auth.logout(request.authToken);
      return { status: "ok" };
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    authToken: string | null;
  }
}

export function requireAuthentication(auth: AuthService) {
  return async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const token = readBearerToken(request);
    const user = token ? await auth.authenticate(token) : null;
    if (!token || !user) {
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Authentication is required." },
      });
    }
    request.authToken = token;
    request.authUser = user;
  };
}

export function createLegacyBirthdayVerifier(
  pepper: string,
  userId: string,
  birthday: string,
): string | null {
  const canonical = canonicalizeBirthday(birthday);
  return canonical
    ? computeLegacyBirthdayVerifier(pepper, userId, canonical)
    : null;
}

function computeLegacyBirthdayVerifier(
  pepper: string,
  userId: string,
  canonicalBirthday: string,
): string {
  return createHmac("sha256", pepper)
    .update(`${userId}:${canonicalBirthday}`)
    .digest("hex");
}

function readBearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

function normalizePhone(phone: string): string | null {
  if (!/^[+\d\s().-]+$/.test(phone)) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function canonicalizeBirthday(birthday: string): string | null {
  const match = birthday.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yearText}${monthText}${dayText}`;
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
