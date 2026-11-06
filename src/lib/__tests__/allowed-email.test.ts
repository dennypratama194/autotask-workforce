import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedEmail } from "../allowed-email";

describe("isAllowedEmail", () => {
  const original = process.env.ALLOWED_EMAIL;
  beforeEach(() => {
    process.env.ALLOWED_EMAIL = "Denny@Example.com";
  });
  afterEach(() => {
    process.env.ALLOWED_EMAIL = original;
  });

  it("matches case-insensitively and ignores whitespace", () => {
    expect(isAllowedEmail("  denny@example.com ")).toBe(true);
  });

  it("rejects other emails", () => {
    expect(isAllowedEmail("other@example.com")).toBe(false);
  });

  it("rejects empty values", () => {
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
  });

  it("rejects everything when ALLOWED_EMAIL is unset", () => {
    delete process.env.ALLOWED_EMAIL;
    expect(isAllowedEmail("denny@example.com")).toBe(false);
  });
});
