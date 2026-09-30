import { http } from "../lib.mjs";

export async function suiteAuth(t, ctx) {
  t.suite("Auth");

  await t.test("admin login returns admin role + JWT", async () => {
    t.eq(ctx.admin.user.role, "admin");
    t.eq(ctx.admin.user.username, ctx.adminUser);
    t.ok(ctx.admin.token.length > 20);
  });

  await t.test("trader login returns trader role", async () => {
    t.eq(ctx.t1.user.role, "trader");
    t.ok(ctx.t1.user.id);
  });

  await t.test("GET /api/auth/me with token", async () => {
    const me = await http.get("/api/auth/me", { token: ctx.t1.token });
    t.eq(me.id, ctx.t1.user.id);
    t.eq(me.username, ctx.t1.user.username);
    t.eq(me.role, "trader");
  });

  await t.test("GET /api/auth/me without token is 401", async () => {
    await t.throws(() => http.get("/api/auth/me"), { status: 401 });
  });

  await t.test("GET /api/auth/me with garbage token is 401", async () => {
    await t.throws(() => http.get("/api/auth/me", { token: "not-a-jwt" }), {
      status: 401,
    });
  });

  await t.test("invalid credentials are 401", async () => {
    await t.throws(
      () => http.post("/api/auth/login", { username: ctx.adminUser, password: "wrong-password" }),
      { status: 401, error: "invalid_credentials" },
    );
  });

  await t.test("new registration is closed", async () => {
    const r = await http.request("POST", "/api/auth/register", {
      body: {
        username: "closedreguser",
        email: "closed@e2e.quanta.test",
        password: "e2epassword1",
        role: "admin",
      },
    });
    t.eq(r.status, 403);
    t.eq(r.body.error, "registration_closed");
  });
}
