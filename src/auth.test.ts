import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, createLegacyBirthdayVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { AuthStore, AuthenticatedUser, IssuedSession } from "./auth.js";
import type { SessionDocument } from "./models.js";

const pepper = "test-only-legacy-auth-pepper-32-bytes";
const phone = "1234567890";
const birthday = "04/05/1990";

class MemoryAuthStore implements AuthStore {
  readonly user: {
    _id: string;
    name: string;
    phoneNormalized: string;
    legacyBirthdayVerifier?: string;
  } = {
    _id: "user-1",
    name: "Test User",
    phoneNormalized: phone,
    legacyBirthdayVerifier: createLegacyBirthdayVerifier(
      pepper,
      "user-1",
      birthday,
    )!,
  };
  readonly sessions = new Map<string, SessionDocument>();

  async findUserByPhone(phoneNormalized: string) {
    return phoneNormalized === this.user.phoneNormalized ? this.user : null;
  }

  async findUserById(userId: string): Promise<AuthenticatedUser | null> {
    return userId === this.user._id
      ? { id: this.user._id, name: this.user.name }
      : null;
  }

  async createSession(session: SessionDocument) {
    this.sessions.set(session.tokenHash, session);
  }

  async findActiveSession(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    return session && !session.revokedAt && session.expiresAt > now
      ? session
      : null;
  }

  async revokeSession(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = now;
  }
}

test("logs in with legacy phone and birthday, and revokes opaque sessions", async () => {
  const store = new MemoryAuthStore();
  const auth = new AuthService(store, pepper);
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    database: { async ping() {} },
    auth,
  });

  try {
    const invalidProof = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { phone, birthday: "05/05/1990" },
    });
    assert.equal(invalidProof.statusCode, 401);

    const loggedInResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { phone: "(123) 456-7890", birthday },
    });
    assert.equal(loggedInResponse.statusCode, 200);
    const firstSession = loggedInResponse.json<IssuedSession>();
    assert.equal(firstSession.user.id, "user-1");
    assert.ok(store.user.legacyBirthdayVerifier);
    assert.notEqual(
      [...store.sessions.values()][0]?.tokenHash,
      firstSession.accessToken,
    );

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me?userId=another-user",
      headers: { authorization: `Bearer ${firstSession.accessToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), {
      user: { id: "user-1", name: "Test User" },
    });

    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { phone, birthday },
    });
    assert.equal(secondLogin.statusCode, 200);
    const secondSession = secondLogin.json<IssuedSession>();
    assert.notEqual(secondSession.accessToken, firstSession.accessToken);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${firstSession.accessToken}` },
    });
    assert.equal(logout.statusCode, 200);
    const revokedMe = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${firstSession.accessToken}` },
    });
    assert.equal(revokedMe.statusCode, 401);

    const loggedInMe = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${secondSession.accessToken}` },
    });
    assert.equal(loggedInMe.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("legacy login reports disabled when its verification secret is not configured", async () => {
  const auth = new AuthService(new MemoryAuthStore());
  const app = await buildApp({
    config: parseConfig({ NODE_ENV: "test" }),
    database: { async ping() {} },
    auth,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { phone, birthday },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "AUTH_NOT_CONFIGURED");
  } finally {
    await app.close();
  }
});
