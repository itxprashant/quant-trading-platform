import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString?: string) {
  const url =
    connectionString ??
    process.env.DATABASE_URL ??
    "postgresql://qtp:qtp@localhost:5432/qtp";
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema, casing: "snake_case" });
}

let singleton: Database | undefined;

/** Shared pooled connection for long-lived services. */
export function getDb(): Database {
  if (!singleton) singleton = createDb();
  return singleton;
}
