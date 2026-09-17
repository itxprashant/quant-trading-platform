import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url =
    process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp";
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
