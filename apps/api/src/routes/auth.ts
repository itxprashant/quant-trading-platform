import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { users } from "@qtp/db";
import { zLoginInput, zRegisterInput, type UserPublic } from "@qtp/shared";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";

const authLimit = rateLimit({
  bucket: "auth",
  limit: 10,
  windowMs: 60_000,
  by: "ip",
});

function toPublic(u: typeof users.$inferSelect): UserPublic {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/register", { preHandler: [authLimit] }, async (req, reply) => {
    const input = validate(zRegisterInput, req.body, reply);
    if (!input) return;

    const existing = await app.db.query.users.findFirst({
      where: eq(users.username, input.username),
    });
    if (existing) {
      return reply.code(409).send({ error: "username_taken" });
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const [created] = await app.db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName ?? input.username,
        passwordHash,
        role: "trader",
      })
      .returning();

    const user = toPublic(created!);
    const token = app.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });
    return reply.code(201).send({ token, user });
  });

  app.post("/login", { preHandler: [authLimit] }, async (req, reply) => {
    const input = validate(zLoginInput, req.body, reply);
    if (!input) return;

    const found = await app.db.query.users.findFirst({
      where: eq(users.username, input.username),
    });
    if (!found || !(await bcrypt.compare(input.password, found.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    await app.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, found.id));

    const user = toPublic(found);
    const token = app.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });
    return { token, user };
  });

  app.get(
    "/me",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const found = await app.db.query.users.findFirst({
        where: eq(users.id, req.user.sub),
      });
      if (!found) return reply.code(404).send({ error: "not_found" });
      return toPublic(found);
    },
  );
}
