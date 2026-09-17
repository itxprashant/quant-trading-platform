import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@qtp/shared";
import { env } from "./env.js";

export interface JwtUser {
  sub: string;
  username: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    requireAdmin: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    /** Verify token if present, but never reject. */
    optionalAuth: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.jwtExpiresIn },
  });

  app.decorate(
    "authenticate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        await reply.code(401).send({ error: "unauthorized" });
      }
    },
  );

  app.decorate(
    "requireAdmin",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (req.user.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
    },
  );

  app.decorate(
    "optionalAuth",
    async (req: FastifyRequest) => {
      try {
        await req.jwtVerify();
      } catch {
        // anonymous; leave req.user unset
      }
    },
  );
}
