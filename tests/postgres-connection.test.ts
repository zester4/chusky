import assert from "node:assert/strict";
import test from "node:test";
import { securePostgresConnectionString } from "../src/postgresConnection.js";

test("postgres connection strings use explicit full certificate verification", () => {
  assert.equal(
    securePostgresConnectionString("postgresql://user:pass@example.test/db?sslmode=require"),
    "postgresql://user:pass@example.test/db?sslmode=verify-full",
  );
  assert.equal(
    securePostgresConnectionString("postgresql://user:pass@example.test/db?sslmode=prefer&connect_timeout=10"),
    "postgresql://user:pass@example.test/db?sslmode=verify-full&connect_timeout=10",
  );
});

test("postgres connection normalization leaves strict, non-Postgres, and blank values safe", () => {
  const strict = "postgresql://user:pass@example.test/db?sslmode=verify-full";
  assert.equal(securePostgresConnectionString(strict), strict);
  assert.equal(securePostgresConnectionString("mysql://user:pass@example.test/db"), "mysql://user:pass@example.test/db");
  assert.equal(securePostgresConnectionString(""), "");
});
