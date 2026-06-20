import { buildApp } from "./app.js";
import { env } from "./env.js";

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ host: "0.0.0.0", port: env.port });
    app.log.info(`API listening on :${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      app.log.info(`Received ${sig}, shutting down`);
      await app.close();
      process.exit(0);
    });
  }
}

main();
