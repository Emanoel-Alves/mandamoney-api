import { createLegacyBirthdayVerifier } from "./auth.js";
import { createLegacyCategory } from "./categories.js";
import type {
  BalanceDocument,
  BalanceItemDocument,
  BalanceStatus,
  CategoryDocument,
  DisputeDocument,
  ItemDocument,
  PaymentRequestDocument,
  UserDocument,
} from "./models.js";

const decimalScale = 1_000_000_000_000n;
const centsPerUnit = 100n;
const maximumAmountCents = BigInt(Number.MAX_SAFE_INTEGER);

export type LegacyExportFiles = Record<
  | "Usuarios"
  | "Compras_Itens"
  | "Saldos"
  | "Saldo_Itens"
  | "Pagamentos"
  | "Contestacoes",
  string
>;

export type MigrationIssue = {
  file: keyof LegacyExportFiles;
  row: number;
  column: string;
  code: string;
};

export type MigrationDocuments = {
  users: UserDocument[];
  items: ItemDocument[];
  categories: CategoryDocument[];
  balances: BalanceDocument[];
  balanceItems: BalanceItemDocument[];
  paymentRequests: PaymentRequestDocument[];
  disputes: DisputeDocument[];
};

export type MigrationReport = {
  counts: Record<keyof MigrationDocuments, number>;
  rows: Record<
    keyof LegacyExportFiles,
    { read: number; imported: number; ignored: number; invalid: number }
  >;
  totals: {
    itemAmountCents: number;
    balanceAmountCents: number;
    balanceItemAmountCents: number;
    paymentAmountCents: number;
    disputeAmountCents: number;
  };
  issues: MigrationIssue[];
  documents: MigrationDocuments;
};

type CsvRow = {
  rowNumber: number;
  values: string[];
  headerIndexes?: Map<string, number>;
};
type CsvTable = {
  headers: string[];
  rows: CsvRow[];
  ignoredRows: number;
};
type RawBalanceItem = {
  balanceId: string;
  itemId: string;
  debtorId: string;
  creditorId: string;
  value: bigint;
  rowNumber: number;
};

const requiredHeaders = {
  Usuarios: ["ID", "Nome", "Telefone", "Aniversario"],
  Compras_Itens: [
    "ID_Item",
    "Data",
    "Mercado",
    "Produto",
    "Categoria",
    "Valor_Total",
    "Comprador_ID",
    "Pertence_A",
    "Pago_Direto_Por",
  ],
  Saldos: [
    "ID",
    "Devedor_ID",
    "Credor_ID",
    "Valor",
    "Status",
    "Data_Pagamento",
  ],
  Saldo_Itens: ["Saldo_ID", "Item_ID", "Devedor_ID", "Credor_ID", "Valor"],
  Pagamentos: [
    "ID",
    "Balance_ID",
    "Devedor_ID",
    "Credor_ID",
    "Valor",
    "Status",
    "Data_Solicitacao",
    "Data_Confirmacao",
  ],
  Contestacoes: [
    "ID",
    "Saldo_ID",
    "Item_ID",
    "Devedor_ID",
    "Credor_ID",
    "Valor",
    "Status",
    "Data_Solicitacao",
    "Data_Resolucao",
  ],
} as const;

export function parseLegacyCsv(input: string): CsvTable {
  input = input.replace(/^\uFEFF/, "");
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let endedRecord = false;
  let recordNumber = 1;
  let ignoredRows = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      endedRecord = false;
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
      endedRecord = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      endedRecord = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) {
        rows.push({ rowNumber: recordNumber, values: row });
      } else {
        ignoredRows += 1;
      }
      row = [];
      field = "";
      endedRecord = true;
      recordNumber += 1;
    } else {
      field += character;
      endedRecord = false;
    }
  }
  if (inQuotes) throw new Error("CSV contains an unclosed quoted field.");
  if (!endedRecord || field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim() !== "")) {
      rows.push({ rowNumber: recordNumber, values: row });
    } else {
      ignoredRows += 1;
    }
  }

  const headerRow = rows.shift();
  if (!headerRow) throw new Error("CSV is empty.");
  const headers = headerRow.values.map((header) => header.trim());
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV contains duplicate column names.");
  }
  const headerIndexes = new Map(
    headers.map((header, index) => [header, index]),
  );
  return {
    headers,
    ignoredRows,
    rows: rows.map(({ rowNumber, values }) => ({
      rowNumber,
      values,
      headerIndexes,
    })),
  };
}

export function transformLegacyExports(
  files: LegacyExportFiles,
  legacyAuthPepper: string,
  importedAt = new Date(),
): MigrationReport {
  if (legacyAuthPepper.length < 32) {
    throw new Error("LEGACY_AUTH_PEPPER must contain at least 32 characters.");
  }
  const issues: MigrationIssue[] = [];
  const tables = {} as Record<keyof LegacyExportFiles, CsvTable>;

  for (const file of Object.keys(
    requiredHeaders,
  ) as (keyof LegacyExportFiles)[]) {
    let table: CsvTable;
    try {
      table = parseLegacyCsv(files[file]);
    } catch {
      issues.push({ file, row: 1, column: "CSV", code: "invalid_csv" });
      table = { headers: [], rows: [], ignoredRows: 0 };
    }
    tables[file] = table;
    for (const row of table.rows) {
      if (row.values.length > table.headers.length) {
        issue(issues, file, row, "CSV", "extra_columns");
      }
    }
    for (const header of requiredHeaders[file]) {
      if (!table.headers.includes(header)) {
        issues.push({
          file,
          row: 1,
          column: header,
          code: "missing_column",
        });
      }
    }
  }

  const users: UserDocument[] = [];
  const items: ItemDocument[] = [];
  const categories = new Map<string, CategoryDocument>();
  const balances: BalanceDocument[] = [];
  const rawBalanceItems: RawBalanceItem[] = [];
  const validBalanceItems: RawBalanceItem[] = [];
  const rawBalanceAmounts = new Map<string, bigint>();
  const paymentRequests: PaymentRequestDocument[] = [];
  const disputes: DisputeDocument[] = [];
  const userIds = new Set<string>();
  const itemIds = new Set<string>();
  const balanceIds = new Set<string>();
  const phoneNumbers = new Set<string>();

  for (const row of tables.Usuarios.rows) {
    const file = "Usuarios";
    const id = field(file, row, "ID", issues);
    const name = field(file, row, "Nome", issues);
    const phone = field(file, row, "Telefone", issues);
    const birthday = field(file, row, "Aniversario", issues);
    if (!id || !name || !phone || !birthday) continue;
    if (duplicate(id, userIds)) {
      issue(issues, file, row, "ID", "duplicate_id");
      continue;
    }
    const phoneNormalized = normalizeLegacyPhone(phone);
    if (!phoneNormalized) {
      issue(issues, file, row, "Telefone", "invalid_phone");
      continue;
    }
    if (phoneNumbers.has(phoneNormalized)) {
      issue(issues, file, row, "Telefone", "duplicate_phone");
      continue;
    }
    const legacyBirthdayVerifier = createLegacyBirthdayVerifier(
      legacyAuthPepper,
      id,
      birthday,
    );
    if (!legacyBirthdayVerifier) {
      issue(issues, file, row, "Aniversario", "invalid_birthday");
      continue;
    }
    userIds.add(id);
    phoneNumbers.add(phoneNormalized);
    users.push({
      _id: id,
      legacyId: id,
      name,
      phoneNormalized,
      legacyBirthdayVerifier,
      createdAt: importedAt,
      updatedAt: importedAt,
    });
  }

  for (const row of tables.Compras_Itens.rows) {
    const file = "Compras_Itens";
    const id = field(file, row, "ID_Item", issues);
    const dateText = field(file, row, "Data", issues);
    const market = field(file, row, "Mercado", issues);
    const product = field(file, row, "Produto", issues);
    const category = field(file, row, "Categoria", issues, true);
    const amountText = field(file, row, "Valor_Total", issues);
    const buyerId = field(file, row, "Comprador_ID", issues);
    const participantsText = field(file, row, "Pertence_A", issues);
    const paidDirectlyText = field(file, row, "Pago_Direto_Por", issues, true);
    if (
      !id ||
      !dateText ||
      !market ||
      !product ||
      amountText === undefined ||
      !buyerId ||
      participantsText === undefined ||
      paidDirectlyText === undefined
    ) {
      continue;
    }
    if (duplicate(id, itemIds)) {
      issue(issues, file, row, "ID_Item", "duplicate_id");
      continue;
    }
    const date = parseLegacyDate(dateText);
    const amountCents = parseMoneyCents(amountText);
    const participantIds = parseIdList(participantsText);
    const paidDirectlyBy = parseIdList(paidDirectlyText);
    let valid = true;
    if (!date) {
      issue(issues, file, row, "Data", "invalid_date");
      valid = false;
    }
    if (amountCents === null || amountCents <= 0) {
      issue(issues, file, row, "Valor_Total", "invalid_amount");
      valid = false;
    }
    if (
      !participantIds.length ||
      new Set(participantIds).size !== participantIds.length
    ) {
      issue(issues, file, row, "Pertence_A", "invalid_participants");
      valid = false;
    }
    if (!participantIds.includes(buyerId)) {
      issue(issues, file, row, "Comprador_ID", "buyer_not_participant");
      valid = false;
    }
    if (paidDirectlyBy.some((id) => !participantIds.includes(id))) {
      issue(issues, file, row, "Pago_Direto_Por", "payer_not_participant");
      valid = false;
    }
    if (participantIds.some((id) => !userIds.has(id))) {
      issue(issues, file, row, "Pertence_A", "unknown_user_reference");
      valid = false;
    }
    if (paidDirectlyBy.some((id) => !userIds.has(id))) {
      issue(issues, file, row, "Pago_Direto_Por", "unknown_user_reference");
      valid = false;
    }
    if (!userIds.has(buyerId)) {
      issue(issues, file, row, "Comprador_ID", "unknown_user_reference");
      valid = false;
    }
    if (!valid || !date || amountCents === null) continue;
    itemIds.add(id);
    const categoryDocument = createLegacyCategory(
      category || "Outros",
      importedAt,
    );
    categories.set(categoryDocument._id, categoryDocument);
    items.push({
      _id: id,
      legacyId: id,
      buyerId,
      date,
      market,
      product,
      category: category || "Outros",
      amountCents,
      participantIds,
      paidDirectlyBy,
      createdAt: importedAt,
    });
  }

  for (const row of tables.Saldos.rows) {
    const file = "Saldos";
    const id = field(file, row, "ID", issues);
    const debtorId = field(file, row, "Devedor_ID", issues);
    const creditorId = field(file, row, "Credor_ID", issues);
    const amountText = field(file, row, "Valor", issues);
    const statusText = field(file, row, "Status", issues);
    const paidAtText = field(file, row, "Data_Pagamento", issues, true);
    if (
      !id ||
      !debtorId ||
      !creditorId ||
      amountText === undefined ||
      !statusText ||
      paidAtText === undefined
    ) {
      continue;
    }
    if (duplicate(id, balanceIds)) {
      issue(issues, file, row, "ID", "duplicate_id");
      continue;
    }
    const amountCents = parseAmountCents(amountText);
    const rawAmount = parseDecimalUnits(amountText);
    const status = parseBalanceStatus(statusText);
    const paidAt = paidAtText ? parseLegacyDateTime(paidAtText) : null;
    let valid = true;
    if (!userIds.has(debtorId) || !userIds.has(creditorId)) {
      issue(issues, file, row, "Devedor_ID", "unknown_user_reference");
      valid = false;
    }
    if (debtorId === creditorId) {
      issue(issues, file, row, "Credor_ID", "invalid_balance_pair");
      valid = false;
    }
    if (amountCents === null || amountCents < 0) {
      issue(issues, file, row, "Valor", "invalid_amount");
      valid = false;
    }
    if (!status) {
      issue(issues, file, row, "Status", "unknown_status");
      valid = false;
    }
    if (paidAtText && !paidAt) {
      issue(issues, file, row, "Data_Pagamento", "invalid_date");
      valid = false;
    }
    if (!valid || amountCents === null || !status) continue;
    balanceIds.add(id);
    if (rawAmount !== null) rawBalanceAmounts.set(id, rawAmount);
    balances.push({
      _id: id,
      legacyId: id,
      debtorId,
      creditorId,
      amountCents,
      status,
      paidAt,
      updatedAt: importedAt,
    });
  }

  for (const row of tables.Saldo_Itens.rows) {
    const file = "Saldo_Itens";
    const balanceId = field(file, row, "Saldo_ID", issues);
    const itemId = field(file, row, "Item_ID", issues);
    const debtorId = field(file, row, "Devedor_ID", issues);
    const creditorId = field(file, row, "Credor_ID", issues);
    const valueText = field(file, row, "Valor", issues);
    if (
      !balanceId ||
      !itemId ||
      !debtorId ||
      !creditorId ||
      valueText === undefined
    ) {
      continue;
    }
    const value = parseDecimalUnits(valueText);
    if (value === null || value <= 0n) {
      issue(issues, file, row, "Valor", "invalid_amount");
      continue;
    }
    rawBalanceItems.push({
      balanceId,
      itemId,
      debtorId,
      creditorId,
      value,
      rowNumber: row.rowNumber,
    });
  }

  const balanceItemIds = new Set<string>();
  for (const row of rawBalanceItems) {
    const balance = balances.find((entry) => entry._id === row.balanceId);
    const item = items.find((entry) => entry._id === row.itemId);
    if (!balance) {
      issue(
        issues,
        "Saldo_Itens",
        { rowNumber: row.rowNumber, values: [] },
        "Saldo_ID",
        "unknown_balance_reference",
      );
      continue;
    }
    if (!item) {
      issue(
        issues,
        "Saldo_Itens",
        { rowNumber: row.rowNumber, values: [] },
        "Item_ID",
        "unknown_item_reference",
      );
      continue;
    }
    if (
      balance.debtorId !== row.debtorId ||
      balance.creditorId !== row.creditorId
    ) {
      issue(
        issues,
        "Saldo_Itens",
        { rowNumber: row.rowNumber, values: [] },
        "Devedor_ID",
        "balance_pair_mismatch",
      );
      continue;
    }
    if (
      item.buyerId !== row.creditorId ||
      !item.participantIds.includes(row.debtorId)
    ) {
      issue(
        issues,
        "Saldo_Itens",
        { rowNumber: row.rowNumber, values: [] },
        "Item_ID",
        "item_party_mismatch",
      );
      continue;
    }
    const id = `${row.balanceId}:${row.itemId}`;
    if (balanceItemIds.has(id)) {
      issue(
        issues,
        "Saldo_Itens",
        { rowNumber: row.rowNumber, values: [] },
        "Item_ID",
        "duplicate_balance_item",
      );
      continue;
    }
    balanceItemIds.add(id);
    validBalanceItems.push(row);
  }

  const balanceItems = allocateBalanceItemCents(
    validBalanceItems,
    balances,
    rawBalanceAmounts,
    issues,
  );

  for (const row of tables.Pagamentos.rows) {
    const file = "Pagamentos";
    const id = field(file, row, "ID", issues);
    const balanceId = field(file, row, "Balance_ID", issues);
    const debtorId = field(file, row, "Devedor_ID", issues);
    const creditorId = field(file, row, "Credor_ID", issues);
    const amountText = field(file, row, "Valor", issues);
    const statusText = field(file, row, "Status", issues);
    const requestedText = field(file, row, "Data_Solicitacao", issues);
    const resolvedText = field(file, row, "Data_Confirmacao", issues, true);
    if (
      !id ||
      !balanceId ||
      !debtorId ||
      !creditorId ||
      amountText === undefined ||
      !statusText ||
      !requestedText ||
      resolvedText === undefined
    ) {
      continue;
    }
    const amountCents = parseAmountCents(amountText);
    const status = parsePaymentStatus(statusText);
    const requestedAt = parseLegacyDateTime(requestedText);
    const resolvedAt = resolvedText ? parseLegacyDateTime(resolvedText) : null;
    const balance = balances.find((entry) => entry._id === balanceId);
    if (paymentRequests.some((entry) => entry._id === id)) {
      issue(issues, file, row, "ID", "duplicate_id");
      continue;
    }
    if (
      !balance ||
      balance.debtorId !== debtorId ||
      balance.creditorId !== creditorId
    ) {
      issue(issues, file, row, "Balance_ID", "unknown_or_mismatched_balance");
      continue;
    }
    if (!userIds.has(debtorId) || !userIds.has(creditorId)) {
      issue(issues, file, row, "Devedor_ID", "unknown_user_reference");
      continue;
    }
    if (amountCents === null || amountCents <= 0) {
      issue(issues, file, row, "Valor", "invalid_amount");
      continue;
    }
    if (!status) {
      issue(issues, file, row, "Status", "unknown_status");
      continue;
    }
    if (!requestedAt || (resolvedText && !resolvedAt)) {
      issue(issues, file, row, "Data_Solicitacao", "invalid_date");
      continue;
    }
    paymentRequests.push({
      _id: id,
      legacyId: id,
      balanceId,
      debtorId,
      creditorId,
      amountCents,
      status,
      requestedAt,
      resolvedAt,
    });
  }

  for (const row of tables.Contestacoes.rows) {
    const file = "Contestacoes";
    const id = field(file, row, "ID", issues);
    const balanceId = field(file, row, "Saldo_ID", issues);
    const itemId = field(file, row, "Item_ID", issues);
    const debtorId = field(file, row, "Devedor_ID", issues);
    const creditorId = field(file, row, "Credor_ID", issues);
    const amountText = field(file, row, "Valor", issues);
    const statusText = field(file, row, "Status", issues);
    const requestedText = field(file, row, "Data_Solicitacao", issues);
    const resolvedText = field(file, row, "Data_Resolucao", issues, true);
    if (
      !id ||
      !balanceId ||
      !itemId ||
      !debtorId ||
      !creditorId ||
      amountText === undefined ||
      !statusText ||
      !requestedText ||
      resolvedText === undefined
    ) {
      continue;
    }
    const amountCents = parseAmountCents(amountText);
    const status = parseDisputeStatus(statusText);
    const requestedAt = parseLegacyDateTime(requestedText);
    const resolvedAt = resolvedText ? parseLegacyDateTime(resolvedText) : null;
    const balance = balances.find((entry) => entry._id === balanceId);
    if (disputes.some((entry) => entry._id === id)) {
      issue(issues, file, row, "ID", "duplicate_id");
      continue;
    }
    if (
      !balance ||
      balance.debtorId !== debtorId ||
      balance.creditorId !== creditorId
    ) {
      issue(issues, file, row, "Saldo_ID", "unknown_or_mismatched_balance");
      continue;
    }
    if (!itemIds.has(itemId)) {
      issue(issues, file, row, "Item_ID", "unknown_item_reference");
      continue;
    }
    if (!userIds.has(debtorId) || !userIds.has(creditorId)) {
      issue(issues, file, row, "Devedor_ID", "unknown_user_reference");
      continue;
    }
    if (amountCents === null || amountCents <= 0) {
      issue(issues, file, row, "Valor", "invalid_amount");
      continue;
    }
    if (!status) {
      issue(issues, file, row, "Status", "unknown_status");
      continue;
    }
    if (!requestedAt || (resolvedText && !resolvedAt)) {
      issue(issues, file, row, "Data_Solicitacao", "invalid_date");
      continue;
    }
    disputes.push({
      _id: id,
      legacyId: id,
      balanceId,
      itemId,
      debtorId,
      creditorId,
      amountCents,
      status,
      requestedAt,
      resolvedAt,
    });
  }

  const documents = {
    users,
    items,
    categories: [...categories.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    ),
    balances,
    balanceItems,
    paymentRequests,
    disputes,
  };
  const invalidRows = new Map<keyof LegacyExportFiles, Set<number>>();
  for (const entry of issues) {
    const rows = invalidRows.get(entry.file) ?? new Set<number>();
    rows.add(entry.row);
    invalidRows.set(entry.file, rows);
  }
  const sourceCounts = {
    Usuarios: users.length,
    Compras_Itens: items.length,
    Saldos: balances.length,
    Saldo_Itens: balanceItems.length,
    Pagamentos: paymentRequests.length,
    Contestacoes: disputes.length,
  };
  return {
    counts: Object.fromEntries(
      Object.entries(documents).map(([collection, values]) => [
        collection,
        values.length,
      ]),
    ) as MigrationReport["counts"],
    rows: Object.fromEntries(
      (Object.keys(requiredHeaders) as (keyof LegacyExportFiles)[]).map(
        (file) => [
          file,
          {
            read: tables[file].rows.length,
            imported: sourceCounts[file],
            ignored: tables[file].ignoredRows,
            invalid: invalidRows.get(file)?.size ?? 0,
          },
        ],
      ),
    ) as MigrationReport["rows"],
    totals: {
      itemAmountCents: sum(items.map((item) => item.amountCents)),
      balanceAmountCents: sum(balances.map((balance) => balance.amountCents)),
      balanceItemAmountCents: sum(balanceItems.map((item) => item.shareCents)),
      paymentAmountCents: sum(
        paymentRequests.map((payment) => payment.amountCents),
      ),
      disputeAmountCents: sum(disputes.map((dispute) => dispute.amountCents)),
    },
    issues,
    documents,
  };
}

function allocateBalanceItemCents(
  rows: RawBalanceItem[],
  balances: BalanceDocument[],
  rawBalanceAmounts: Map<string, bigint>,
  issues: MigrationIssue[],
): BalanceItemDocument[] {
  const byBalance = new Map<string, RawBalanceItem[]>();
  for (const row of rows) {
    const entries = byBalance.get(row.balanceId) ?? [];
    entries.push(row);
    byBalance.set(row.balanceId, entries);
  }

  const result: BalanceItemDocument[] = [];
  for (const [balanceId, entries] of byBalance) {
    const balance = balances.find((entry) => entry._id === balanceId);
    if (!balance) continue;
    const total = entries.reduce((value, entry) => value + entry.value, 0n);
    const sourceBalance = rawBalanceAmounts.get(balanceId);
    if (
      sourceBalance === undefined ||
      absolute(total - sourceBalance) > 10_000n
    ) {
      issues.push({
        file: "Saldo_Itens",
        row: entries[0]?.rowNumber ?? 1,
        column: "Valor",
        code: "balance_item_total_mismatch",
      });
      continue;
    }
    if (total <= 0n) continue;
    const targetCents = BigInt(balance.amountCents);
    const allocations = entries.map((entry) => {
      const numerator = entry.value * targetCents;
      return {
        entry,
        cents: numerator / total,
        remainder: numerator % total,
      };
    });
    let remainder =
      targetCents - allocations.reduce((n, row) => n + row.cents, 0n);
    allocations.sort(
      (left, right) =>
        Number(right.remainder - left.remainder) ||
        left.entry.itemId.localeCompare(right.entry.itemId),
    );
    for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
      allocations[index % allocations.length]!.cents += 1n;
    }
    for (const allocation of allocations) {
      if (allocation.cents > maximumAmountCents) {
        issues.push({
          file: "Saldo_Itens",
          row: allocation.entry.rowNumber,
          column: "Valor",
          code: "amount_out_of_range",
        });
        continue;
      }
      result.push({
        _id: `${balanceId}:${allocation.entry.itemId}`,
        balanceId,
        itemId: allocation.entry.itemId,
        debtorId: allocation.entry.debtorId,
        creditorId: allocation.entry.creditorId,
        shareCents: Number(allocation.cents),
      });
    }
  }
  for (const balance of balances) {
    if (balance.amountCents > 0 && !byBalance.has(balance._id)) {
      issues.push({
        file: "Saldo_Itens",
        row: 1,
        column: "Saldo_ID",
        code: "balance_items_missing",
      });
    }
  }
  return result;
}

function field(
  file: keyof LegacyExportFiles,
  row: CsvRow,
  column: string,
  issues: MigrationIssue[],
  optional = false,
): string | undefined {
  const headerIndex = row.headerIndexes?.get(column.trim());
  if (headerIndex === undefined) return optional ? "" : undefined;
  return readCell(file, row, column, headerIndex, issues, optional);
}

function readCell(
  file: keyof LegacyExportFiles,
  row: CsvRow,
  column: string,
  index: number,
  issues: MigrationIssue[],
  optional: boolean,
): string | undefined {
  const value = row.values[index]?.trim() ?? "";
  if (!value && !optional) {
    issue(issues, file, row, column, "required_value_missing");
    return undefined;
  }
  return value;
}

function issue(
  issues: MigrationIssue[],
  file: keyof LegacyExportFiles,
  row: CsvRow,
  column: string,
  code: string,
): void {
  issues.push({ file, row: row.rowNumber, column, code });
}

function duplicate(id: string, ids: Set<string>): boolean {
  if (ids.has(id)) return true;
  ids.add(id);
  return false;
}

function normalizeLegacyPhone(phone: string): string | null {
  if (!/^[+\d\s().-]+$/.test(phone)) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function parseIdList(value: string): string[] {
  return value
    .split("|")
    .map((id) => id.trim())
    .filter(Boolean);
}

function normalizeNumberText(value: string): string | null {
  let normalized = value
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/\s/g, "");
  if (!normalized || !/^-?[\d.,]+$/.test(normalized)) return null;
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const decimal = normalized[decimalIndex];
    const integer = normalized.slice(0, decimalIndex).replace(/[.,]/g, "");
    const fraction = normalized.slice(decimalIndex + 1);
    normalized = `${integer}.${fraction}`;
    if (decimal === "." && comma > dot) return null;
  } else if (comma >= 0) {
    normalized = normalized.replace(",", ".");
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  return normalized;
}

function parseMoneyCents(value: string): number | null {
  const normalized = normalizeNumberText(value);
  if (!normalized) return null;
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const [, sign = "", whole = "", fraction = ""] = match;
  if (!whole) return null;
  if (fraction.length > 2) return null;
  const cents =
    BigInt(whole) * centsPerUnit + BigInt(fraction.padEnd(2, "0") || "0");
  const signed = sign ? -cents : cents;
  if (signed > maximumAmountCents || signed < -maximumAmountCents) return null;
  return Number(signed);
}

function parseAmountCents(value: string): number | null {
  const units = parseDecimalUnits(value);
  if (units === null) return null;
  const cents = (units * centsPerUnit + decimalScale / 2n) / decimalScale;
  if (cents > maximumAmountCents || cents < -maximumAmountCents) return null;
  return Number(cents);
}

function parseDecimalUnits(value: string): bigint | null {
  const normalized = normalizeNumberText(value);
  if (!normalized) return null;
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const [, sign = "", whole = "", fraction = ""] = match;
  if (!whole) return null;
  if (fraction.length > 12) return null;
  const units =
    BigInt(whole) * decimalScale + BigInt(fraction.padEnd(12, "0") || "0");
  return sign ? -units : units;
}

function parseLegacyDate(value: string): string | null {
  const trimmed = value.trim();
  let match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (match) {
    const [, year = "", month = "", day = ""] = match;
    if (!year || !month || !day) return null;
    if (!validDateParts(Number(year), Number(month), Number(day))) return null;
    return `${year}-${month}-${day}`;
  }
  match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day = "", month = "", year = ""] = match;
  if (!day || !month || !year) return null;
  if (!validDateParts(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseLegacyDateTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    if (!parseLegacyDate(trimmed.slice(0, 10))) return null;
    const iso = new Date(trimmed);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }
  const match = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) return null;
  const [
    ,
    dayText = "",
    monthText = "",
    yearText = "",
    hourText = "0",
    minuteText = "0",
    secondText = "0",
  ] = match;
  if (!dayText || !monthText || !yearText) return null;
  const parts = [
    Number(yearText),
    Number(monthText),
    Number(dayText),
    Number(hourText),
    Number(minuteText),
    Number(secondText),
  ];
  const [year, month, day, hour, minute, second] = parts;
  if (
    !validDateParts(year!, month!, day!) ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  ) {
    return null;
  }
  return new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeStatus(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseBalanceStatus(value: string): BalanceStatus | null {
  const status = normalizeStatus(value);
  if (status === "pendente") return "pending";
  if (status === "contestacao pendente") return "contest_pending";
  if (status === "aguardando confirmacao") return "awaiting_confirmation";
  if (["quitado", "pago"].includes(status)) return "paid";
  if (status === "contestado") return "contested";
  if (["balanceado", "compensado"].includes(status)) return "offset";
  return null;
}

function parsePaymentStatus(
  value: string,
): PaymentRequestDocument["status"] | null {
  const status = normalizeStatus(value);
  if (["pendente", "aguardando confirmacao"].includes(status)) return "pending";
  if (["confirmado", "confirmada", "pago", "quitado"].includes(status))
    return "confirmed";
  if (["recusado", "recusada", "rejeitado", "rejeitada"].includes(status))
    return "rejected";
  return null;
}

function parseDisputeStatus(value: string): DisputeDocument["status"] | null {
  const status = normalizeStatus(value);
  if (["pendente", "contestacao pendente"].includes(status)) return "pending";
  if (["aceito", "aceita", "aprovado", "aprovada"].includes(status))
    return "accepted";
  if (["recusado", "recusada", "rejeitado", "rejeitada"].includes(status))
    return "rejected";
  return null;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
