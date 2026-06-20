import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** Parse + validate with zod, sending a 400 on failure. Returns null on error. */
export function validate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.code(400).send({
      error: "validation_error",
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return null;
  }
  return result.data;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
