import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLegacyCsv, transformLegacyExports } from "./migration.js";

const pepper = "test-only-legacy-pepper-that-is-long-enough";
const importedAt = new Date("2026-10-03T12:00:00.000Z");

function fixtureFiles(): Parameters<typeof transformLegacyExports>[0] {
  return {
    Usuarios: [
      "ID,Nome,Telefone,Aniversario",
      "u1,Person One,5511999990001,01/01/1990",
      "u2,Person Two,5511999990002,02/02/1991",
    ].join("\n"),
    Compras_Itens: [
      "ID_Item,Data,Mercado,Produto,Categoria,Valor_Total,Comprador_ID,Pertence_A,Pago_Direto_Por ",
      'i1,2026-10-01,Store,"Milk,',
      'organic",food,"2,00",u1,u1|u2,',
      'i2,02/10/2026,Store,Bread,food,"3,00",u1,u1|u2,',
    ].join("\n"),
    Saldos: [
      "ID,Devedor_ID,Credor_ID,Valor,Status,Data_Pagamento",
      "b1,u2,u1,0.01,Pendente,",
    ].join("\n"),
    Saldo_Itens: [
      "Saldo_ID,Item_ID,Devedor_ID,Credor_ID,Valor",
      "b1,i1,u2,u1,0.005",
      "b1,i2,u2,u1,0.005",
    ].join("\n"),
    Pagamentos:
      "ID,Balance_ID,Devedor_ID,Credor_ID,Valor,Status,Data_Solicitacao,Data_Confirmacao",
    Contestacoes:
      "ID,Saldo_ID,Item_ID,Devedor_ID,Credor_ID,Valor,Status,Data_Solicitacao,Data_Resolucao",
  };
}

test("CSV parser supports BOM, quotes, commas and embedded newlines", () => {
  const table = parseLegacyCsv(
    '\uFEFF"Name",Value\r\n"Product,\r\norganic","R$ 2,50"\r\n',
  );
  assert.deepEqual(table.headers, ["Name", "Value"]);
  assert.equal(table.rows[0]?.values[0], "Product,\r\norganic");
  assert.equal(table.rows[0]?.values[1], "R$ 2,50");
});

test("transforms exports with stable IDs and deterministic cent allocation", () => {
  const first = transformLegacyExports(fixtureFiles(), pepper, importedAt);
  const second = transformLegacyExports(fixtureFiles(), pepper, importedAt);

  assert.deepEqual(first.issues, []);
  assert.deepEqual(first.counts, {
    users: 2,
    items: 2,
    categories: 1,
    balances: 1,
    balanceItems: 2,
    paymentRequests: 0,
    disputes: 0,
  });
  assert.deepEqual(first.rows.Compras_Itens, {
    read: 2,
    imported: 2,
    ignored: 0,
    invalid: 0,
  });
  assert.deepEqual(first.totals, {
    itemAmountCents: 500,
    balanceAmountCents: 1,
    balanceItemAmountCents: 1,
    paymentAmountCents: 0,
    disputeAmountCents: 0,
  });
  assert.deepEqual(first.documents, second.documents);
  assert.equal(first.documents.categories[0]?.name, "food");
  assert.equal(first.documents.items[0]?.product, "Milk,\norganic");
  assert.equal(first.documents.items[0]?.date, "2026-10-01");
  assert.equal(first.documents.items[0]?.amountCents, 200);
  assert.equal(first.documents.users[0]?.legacyBirthdayVerifier?.length, 64);
  assert.equal(
    first.documents.balanceItems.find((entry) => entry.itemId === "i1")
      ?.shareCents,
    1,
  );
  assert.ok(
    first.documents.users.every(
      (user) => !("birthday" in user) && !("Aniversario" in user),
    ),
  );
});

test("rejects invalid references and reports only file, row, column and code", () => {
  const files = fixtureFiles();
  files.Compras_Itens = files.Compras_Itens.replace(
    "u1,u1|u2,",
    "missing-user,u1|u2,",
  );
  const report = transformLegacyExports(files, pepper, importedAt);

  assert.ok(
    report.issues.some(
      (entry) =>
        entry.file === "Compras_Itens" &&
        entry.column === "Comprador_ID" &&
        entry.code === "unknown_user_reference",
    ),
  );
  assert.ok(
    report.issues.every(
      (entry) => Object.keys(entry).sort().join(",") === "code,column,file,row",
    ),
  );
});

test("rejects malformed CSV rather than guessing at unquoted fields", () => {
  const files = fixtureFiles();
  files.Usuarios = '"ID","Nome\nu1,Person,5511999990001,01/01/1990';
  const report = transformLegacyExports(files, pepper, importedAt);

  assert.ok(
    report.issues.some(
      (entry) => entry.file === "Usuarios" && entry.code === "invalid_csv",
    ),
  );
});

test("CLI dry-run reports aggregates without connecting to MongoDB or exposing rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mandamoney-import-test-"));
  try {
    await Promise.all(
      Object.entries(fixtureFiles()).map(([name, contents]) =>
        writeFile(join(directory, `${name}.csv`), contents, "utf8"),
      ),
    );
    const script = fileURLToPath(
      new URL("./import-legacy.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, directory],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          LEGACY_AUTH_PEPPER: "",
          MONGODB_URI: "",
          NODE_ENV: "test",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      counts: { users: number; items: number; balances: number };
      rows: { Compras_Itens: { imported: number; invalid: number } };
    };
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.counts, {
      users: 2,
      items: 2,
      categories: 1,
      balances: 1,
      balanceItems: 2,
      paymentRequests: 0,
      disputes: 0,
    });
    assert.deepEqual(report.rows.Compras_Itens, {
      read: 2,
      imported: 2,
      ignored: 0,
      invalid: 0,
    });
    assert.equal(result.stdout.includes("Person One"), false);
    assert.equal(result.stdout.includes("5511999990001"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
