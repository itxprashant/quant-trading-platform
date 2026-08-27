import { http, nowId } from "../lib.mjs";

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

  await t.test("register validation rejects bad email / short password / bad username", async () => {
    const r = await http.request("POST", "/api/auth/register", {
      body: { username: "ab", email: "nope", password: "x" },
    });
    t.eq(r.status, 400);
    t.eq(r.body.error, "validation_error");
    t.ok(Array.isArray(r.body.issues) && r.body.issues.length >= 2);
  });

  await t.test("register creates a trader and returns a token", async () => {
    const username = nowId("e2eu");
    const created = await http.post("/api/auth/register", {
      username,
      email: `${username}@e2e.quanta.test`,
      password: "e2epassword1",
      displayName: "E2E Trader",
    });
    t.eq(created.user.username, username);
    t.eq(created.user.role, "trader");
    t.ok(created.token);
    ctx.fresh = created;
    const me = await http.get("/api/auth/me", { token: created.token });
    t.eq(me.username, username);
  });

  await t.test("duplicate username is 409 username_taken", async () => {
    t.ok(ctx.fresh, "previous register must have succeeded");
    await t.throws(
      () =>
        http.post("/api/auth/register", {
          username: ctx.fresh.user.username,
          email: "other@e2e.quanta.test",
          password: "e2epassword1",
        }),
      { status: 409, error: "username_taken" },
    );
  });

  await t.test("register cannot self-assign admin (role always trader)", async () => {
    const username = nowId("e2ea");
    const created = await http.request("POST", "/api/auth/register", {
      body: {
        username,
        email: `${username}@e2e.quanta.test`,
        password: "e2epassword1",
        role: "admin",
      },
    });
    t.eq(created.status, 201);
    t.eq(created.body.user.role, "trader");
    ctx.fresh2 = created.body;
  });
}
