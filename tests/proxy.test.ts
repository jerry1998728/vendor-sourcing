import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

import { constantTimeEqual, proxy } from "@/proxy";

const req = (auth?: string) => new NextRequest("http://localhost:3000/api/runs", { headers: auth ? { authorization: auth } : {} });
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

test("proxy: passes everything through when APP_PASSWORD is unset", () => {
  delete process.env.APP_PASSWORD;
  assert.equal(proxy(req()).status, 200);
});

test("proxy: 401 with a challenge without or with wrong credentials, 200 with the password", () => {
  process.env.APP_PASSWORD = "s3cret:with:colons";
  const denied = proxy(req());
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /Basic realm/);
  assert.equal(proxy(req(basic("anyone", "wrong"))).status, 401);
  assert.equal(proxy(req("Bearer abc")).status, 401);
  assert.equal(proxy(req(basic("anyone", "s3cret:with:colons"))).status, 200);
  assert.equal(proxy(req(basic("", "s3cret:with:colons"))).status, 200);
  delete process.env.APP_PASSWORD;
});

test("constantTimeEqual", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});
