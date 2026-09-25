import type { BondHolding } from "./schemas.js";

/** Mid-event host snapshot of every enrolled trader's restoreable balances. */
export const BACKUP_VERSION = 1;

export const BACKUP_COLUMNS = [
  "type",
  "username",
  "user_id",
  "cash",
  "loan_debt",
  "symbol",
  "quantity",
  "avg_price",
  "bond_id",
  "bond_name",
  "bond_price",
  "bond_face",
  "coupons_paid",
] as const;

export type BackupPosition = {
  symbol: string;
  quantity: number;
  avgPrice: number;
};

export type BackupAccount = {
  username: string;
  userId: string;
  cash: number;
  loanDebt: number;
  positions: BackupPosition[];
  bonds: BondHolding[];
};

export type BackupFile = {
  version: number;
  challengeId?: string;
  challengeSlug?: string;
  exportedAt?: string;
  accounts: BackupAccount[];
};

const HEADER = BACKUP_COLUMNS.join(",");

/**
 * Encode a full-trader snapshot as RFC4180 CSV. Comment lines keep the
 * challenge id so a later import can refuse the wrong event.
 */
export function formatBackupCsv(file: BackupFile): string {
  const lines = [
    `# quantstorm-backup ${file.version}`,
    ...(file.challengeId ? [`# challenge_id,${csvField(file.challengeId)}`] : []),
    ...(file.challengeSlug
      ? [`# challenge_slug,${csvField(file.challengeSlug)}`]
      : []),
    ...(file.exportedAt ? [`# exported_at,${csvField(file.exportedAt)}`] : []),
    HEADER,
  ];
  for (const account of file.accounts) {
    lines.push(
      csvRow([
        "account",
        account.username,
        account.userId,
        account.cash,
        account.loanDebt,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    );
    for (const position of account.positions) {
      if (position.quantity === 0) continue;
      lines.push(
        csvRow([
          "position",
          account.username,
          account.userId,
          "",
          "",
          position.symbol,
          position.quantity,
          position.avgPrice,
          "",
          "",
          "",
          "",
          "",
        ]),
      );
    }
    for (const bond of account.bonds) {
      if (bond.quantity <= 0) continue;
      lines.push(
        csvRow([
          "bond",
          account.username,
          account.userId,
          "",
          "",
          "",
          bond.quantity,
          "",
          bond.bondId,
          bond.name,
          bond.price,
          bond.faceValue,
          bond.couponsPaid,
        ]),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Parse a CSV produced by {@link formatBackupCsv} (or the same columns). */
export function parseBackupCsv(text: string): BackupFile {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (raw.length > 1_500_000) throw new Error("backup_too_large");
  const lines = raw.split("\n");
  let version = BACKUP_VERSION;
  let challengeId: string | undefined;
  let challengeSlug: string | undefined;
  let exportedAt: string | undefined;
  let header: string[] | null = null;
  const accounts = new Map<string, BackupAccount>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const meta = parseMeta(trimmed.slice(1).trim());
      if (meta.version !== undefined) version = meta.version;
      if (meta.challengeId) challengeId = meta.challengeId;
      if (meta.challengeSlug) challengeSlug = meta.challengeSlug;
      if (meta.exportedAt) exportedAt = meta.exportedAt;
      continue;
    }
    const cells = parseCsvLine(trimmed);
    if (!header) {
      header = cells.map((c) => c.trim().toLowerCase());
      if (!header.includes("type")) throw new Error("missing_type_column");
      continue;
    }
    const row: Record<string, string> = Object.fromEntries(
      header.map((name, i) => [name, cells[i] ?? ""]),
    );
    const kind = (row.type ?? "").trim().toLowerCase();
    const username = (row.username ?? "").trim();
    const userId = (row.user_id ?? "").trim();
    if (!username && !userId) throw new Error("missing_trader");
    const key = userId || username.toLowerCase();
    const account = accounts.get(key) ?? {
      username: username || userId,
      userId,
      cash: 0,
      loanDebt: 0,
      positions: [],
      bonds: [],
    };
    if (username) account.username = username;
    if (userId) account.userId = userId;
    if (kind === "account") {
      account.cash = parseFinite(row.cash ?? "", "cash");
      account.loanDebt = parseNonNegative(row.loan_debt ?? "", "loan_debt");
    } else if (kind === "position") {
      const symbol = (row.symbol ?? "").trim();
      if (!symbol) throw new Error("missing_symbol");
      const quantity = parseIntField(row.quantity ?? "", "quantity");
      if (quantity !== 0) {
        const idx = account.positions.findIndex((p) => p.symbol === symbol);
        const next = {
          symbol,
          quantity,
          avgPrice: parseNonNegative(row.avg_price || "0", "avg_price"),
        };
        if (idx >= 0) account.positions[idx] = next;
        else account.positions.push(next);
      }
    } else if (kind === "bond") {
      const bondId = (row.bond_id ?? "").trim();
      if (!bondId) throw new Error("missing_bond_id");
      const quantity = parseIntField(row.quantity ?? "", "quantity");
      if (quantity > 0) {
        const next: BondHolding = {
          bondId,
          name: (row.bond_name ?? "").trim() || bondId,
          quantity,
          price: parseNonNegative(row.bond_price || "0", "bond_price"),
          faceValue: parseNonNegative(row.bond_face || "0", "bond_face"),
          couponsPaid: parseNonNegative(
            row.coupons_paid || "0",
            "coupons_paid",
          ),
        };
        const idx = account.bonds.findIndex((b) => b.bondId === bondId);
        if (idx >= 0) account.bonds[idx] = next;
        else account.bonds.push(next);
      }
    } else if (kind === "order") {
      // Exported for the record; working orders are cancelled on import.
    } else {
      throw new Error("unknown_row_type");
    }
    accounts.set(key, account);
  }

  if (!header) throw new Error("missing_header");
  if (accounts.size > 500) throw new Error("too_many_accounts");
  return {
    version,
    challengeId,
    challengeSlug,
    exportedAt,
    accounts: [...accounts.values()],
  };
}

function parseMeta(text: string): {
  version?: number;
  challengeId?: string;
  challengeSlug?: string;
  exportedAt?: string;
} {
  const match = text.match(/^quantstorm-backup\s+(\d+)\s*$/i);
  if (match) return { version: Number(match[1]) };
  const cells = parseCsvLine(text);
  const key = (cells[0] ?? "").trim().toLowerCase();
  const value = (cells[1] ?? "").trim();
  if (key === "challenge_id" && value) return { challengeId: value };
  if (key === "challenge_slug" && value) return { challengeSlug: value };
  if (key === "exported_at" && value) return { exportedAt: value };
  return {};
}

function parseFinite(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid_${field}`);
  return n;
}

function parseNonNegative(raw: string, field: string): number {
  const n = parseFinite(raw, field);
  if (n < 0) throw new Error(`invalid_${field}`);
  return n;
}

function parseIntField(raw: string, field: string): number {
  const n = parseFinite(raw, field);
  if (!Number.isSafeInteger(n)) throw new Error(`invalid_${field}`);
  return n;
}

function csvRow(values: Array<string | number>): string {
  return values.map((v) => csvField(v)).join(",");
}

function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
