import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const specificationPath = fileURLToPath(
  new URL("../openapi.yaml", import.meta.url),
);

test("OpenAPI contract declares the expected API operations and auth", async () => {
  const source = await readFile(specificationPath, "utf8");
  const spec = parse(source) as {
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
    components?: { securitySchemes?: Record<string, unknown> };
  };

  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths);
  for (const path of [
    "/auth/login",
    "/auth/me",
    "/auth/logout",
    "/bootstrap",
    "/items",
    "/items/batch",
    "/categories",
    "/balances",
    "/household/users",
    "/disputes",
    "/balances/{balanceId}/items",
    "/balances/{balanceId}/payment-requests",
    "/payment-requests/{requestId}/confirm",
    "/balances/{balanceId}/disputes",
    "/disputes/{disputeId}/resolve",
    "/balances/{balanceId}/offset",
    "/notifications",
    "/imports/nfce/qr",
    "/imports/receipt/ocr",
  ]) {
    assert.ok(spec.paths[path], `missing API path ${path}`);
  }
  assert.ok(spec.components?.securitySchemes?.bearerAuth);
  assert.ok(spec.paths["/balances/{balanceId}/offset"]?.post);
  assert.ok(spec.paths["/categories"]?.get);
  assert.ok(spec.paths["/categories"]?.post);
  assert.ok(spec.paths["/payment-requests/{requestId}/confirm"]?.post);
});
