import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expressRequire = createRequire(require.resolve("express"));
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("dependency security regressions", () => {
  it.each(["gzip", "deflate"])(
    "keeps the actual app alive after trailing bytes in a %s request",
    (encoding) => {
      // A subprocess makes an unhandled decoder error fail this test without
      // crashing the test runner. Raw HTTP preserves the decoder timing that
      // a buffered Supertest request can hide (GHSA-27r3-jxmh-p828).
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import { once } from "node:events";
            import http from "node:http";
            import { setTimeout } from "node:timers/promises";
            import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
            import { createApp } from "./src/server.ts";

            const server = createApp().listen(0, "127.0.0.1");
            try {
              await once(server, "listening");
              const port = server.address().port;
              const send = (body, encoding) => new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: "127.0.0.1", port, agent: false,
                  path: "/api/__dependency_security_probe__", method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "content-length": body.length,
                    ...(encoding ? { "content-encoding": encoding } : {}),
                  },
                }, res => {
                  res.on("error", reject);
                  res.resume();
                  res.on("end", () => resolve(res.statusCode));
                });
                req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
                req.on("error", reject);
                req.end(body);
              });
              const json = Buffer.from('{"probe":true}');
              assert.equal(await send(json), 404);
              for (const [encoding, compress] of [
                ["gzip", gzipSync], ["deflate", deflateSync],
                ["br", brotliCompressSync],
              ]) assert.equal(await send(compress(json), encoding), 404);
              assert.equal(await send(Buffer.from("{")), 400);
              assert.equal(await send(Buffer.from(JSON.stringify({
                value: "x".repeat(101 * 1024),
              }))), 413);
              assert.equal(await send(json, "unsupported"), 415);

              const compress = ${JSON.stringify(encoding)} === "gzip" ? gzipSync : deflateSync;
              const malformed = Buffer.concat([
                compress(json), Buffer.from([0]), Buffer.alloc(100 * 1024, "X"),
              ]);
              const status = await send(malformed, ${JSON.stringify(encoding)});
              // A valid frame can finish before the bad suffix is decoded;
              // either a parser rejection or the ordinary unknown route is valid.
              assert.ok([400, 404].includes(status));
              await setTimeout(250);
              assert.equal(await send(json), 404);
              console.log("app survived; compression and parser controls passed");
            } finally {
              server.closeAllConnections();
              await new Promise(resolve => server.close(resolve));
            }
          `,
        ],
        { cwd: root, encoding: "utf8", timeout: 8000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("app survived");
    },
    10000,
  );

  it("rejects ambiguous proxy CIDRs while preserving ordinary trusted ranges", () => {
    const proxyAddr = expressRequire("proxy-addr") as {
      compile: (range: string) => (address: string) => boolean;
    };
    // These malformed/mixed-family ranges previously trusted all IPv4 peers.
    for (const range of ["::ffff:10.0.0.0/8", "::/1"]) {
      try {
        expect(proxyAddr.compile(range)("203.0.113.10")).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/invalid|range|address/i);
      }
    }
    expect(proxyAddr.compile("::ffff:10.0.0.0/104")("10.2.3.4")).toBe(true);
    expect(proxyAddr.compile("10.0.0.0/8")("10.2.3.4")).toBe(true);
    expect(proxyAddr.compile("10.0.0.0/8")("203.0.113.10")).toBe(false);
  });

  it("handles hostile qs serializer properties without changing normal arrays", () => {
    const qs = expressRequire("qs") as typeof import("qs");
    expect(() =>
      qs.stringify({ a: { constructor: { isBuffer: 1 } } }),
    ).not.toThrow();
    expect(() =>
      qs.stringify({ a: [{ toString: 1 }] }, { arrayFormat: "comma" }),
    ).not.toThrow();
    expect(() =>
      qs.parse("a[0]=x,y,z", {
        comma: true,
        arrayLimit: 2,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError);
    expect(qs.stringify({ a: ["x", "y"] }, { arrayFormat: "comma" })).toBe(
      "a=x%2Cy",
    );
    expect(qs.parse("a%5B0%5D=x&a%5B1%5D=y")).toEqual({ a: ["x", "y"] });
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "rejects shell line terminator %j after a comment without executing a shell",
    (newline) => {
      const quote = require("shell-quote").quote as (
        tokens: unknown[],
      ) => string;
      expect(() =>
        quote(["echo", { comment: "x" }, `a${newline}id;#`]),
      ).toThrow(TypeError);
      expect(quote(["echo", "hello world"])).toBe("echo 'hello world'");
    },
  );

  it.each([
    "eslint",
    "@eslint/config-array",
    "@typescript-eslint/typescript-estree",
  ])("preserves %s glob matching with the patched minimatch", (parent) => {
    const boundRequire = createRequire(require.resolve(parent));
    const { Minimatch } = boundRequire("minimatch");
    const matcher = new Minimatch("src/**/*.ts", { dot: true });
    expect(matcher.match("src/server.ts")).toBe(true);
    expect(matcher.match("src/.test.ts")).toBe(true);
    expect(matcher.match("src/services", true)).toBe(true);
    expect(matcher.match("dist/cli.js")).toBe(false);
    expect(
      new Minimatch("src/**/*.ts", { platform: "win32" }).match(
        "src\\server.ts",
      ),
    ).toBe(true);
    expect(
      new Minimatch("!dist/**", { flipNegate: true }).match("dist/cli.js"),
    ).toBe(true);
  });
});
