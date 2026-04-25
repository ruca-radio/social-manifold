import { describe, it, expect } from "vitest";
import { getScheme } from "../src/router/route-by-uri.js";

describe("getScheme", () => {
  it("extracts the scheme from a discord ref", () => {
    expect(getScheme("discord://guild:111/channel:222")).toBe("discord");
  });

  it("extracts the scheme from a telegram ref", () => {
    expect(getScheme("telegram://chat:333/message:444")).toBe("telegram");
  });

  it("returns null for non-URI strings", () => {
    expect(getScheme("not-a-uri")).toBeNull();
    expect(getScheme("")).toBeNull();
    expect(getScheme("//missing-scheme")).toBeNull();
  });

  it("accepts schemes with digits/+/-/. (per RFC 3986)", () => {
    expect(getScheme("matrix.org+v2://room/123")).toBe("matrix.org+v2");
  });
});
