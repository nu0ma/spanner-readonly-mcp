import { Float, Int, Numeric, SpannerDate, Struct } from "@google-cloud/spanner";
import { describe, expect, it } from "vitest";
import { serializeValue } from "../../src/server.ts";

// These tests exercise serializeValue() in isolation against the real Spanner
// wrapper classes (instantiated directly — no live Spanner / emulator needed).
// The function is the only thing standing between Spanner's rich result types
// and JSON.stringify on the wire, so each branch deserves its own assertion.
describe("serializeValue", () => {
  describe("nullish", () => {
    it("preserves null", () => {
      expect(serializeValue(null)).toBeNull();
    });

    it("preserves undefined", () => {
      expect(serializeValue(undefined)).toBeUndefined();
    });
  });

  describe("primitives", () => {
    it("returns numbers untouched", () => {
      expect(serializeValue(42)).toBe(42);
      expect(serializeValue(0)).toBe(0);
      expect(serializeValue(-1.5)).toBe(-1.5);
    });

    it("returns strings untouched", () => {
      expect(serializeValue("hello")).toBe("hello");
      expect(serializeValue("")).toBe("");
    });

    it("returns booleans untouched", () => {
      expect(serializeValue(true)).toBe(true);
      expect(serializeValue(false)).toBe(false);
    });
  });

  describe("Spanner Int", () => {
    it("converts safe-integer Int to a JS number", () => {
      const result = serializeValue(new Int("42"));
      expect(result).toBe(42);
      expect(typeof result).toBe("number");
    });

    it("converts the safe-integer boundary (2^53 - 1) to a JS number", () => {
      const result = serializeValue(new Int(String(Number.MAX_SAFE_INTEGER)));
      expect(result).toBe(Number.MAX_SAFE_INTEGER);
      expect(typeof result).toBe("number");
    });

    it("preserves unsafe-integer Int as the original string to avoid precision loss", () => {
      // 2^53 + 1 — JS Number cannot represent this exactly.
      const huge = "9007199254740993";
      const result = serializeValue(new Int(huge));
      expect(result).toBe(huge);
      expect(typeof result).toBe("string");
    });

    it("preserves a very large negative Int as a string", () => {
      const huge = "-9223372036854775808"; // INT64 min
      const result = serializeValue(new Int(huge));
      expect(result).toBe(huge);
      expect(typeof result).toBe("string");
    });
  });

  describe("Spanner Float", () => {
    it("converts Float to a JS number", () => {
      const result = serializeValue(new Float(3.14));
      expect(result).toBe(3.14);
      expect(typeof result).toBe("number");
    });

    it("converts integer-valued Float to a JS number", () => {
      const result = serializeValue(new Float(7));
      expect(result).toBe(7);
      expect(typeof result).toBe("number");
    });
  });

  describe("Spanner Numeric", () => {
    it("returns the underlying string to preserve full precision", () => {
      const exact = "12345678901234567890.123456789";
      const result = serializeValue(new Numeric(exact));
      expect(result).toBe(exact);
      expect(typeof result).toBe("string");
    });

    it("preserves negative values", () => {
      const result = serializeValue(new Numeric("-0.5"));
      expect(result).toBe("-0.5");
    });
  });

  describe("Buffer (BYTES)", () => {
    it("encodes a Buffer as base64", () => {
      const buf = Buffer.from("hello", "utf8");
      const result = serializeValue(buf);
      expect(result).toBe(buf.toString("base64"));
      expect(result).toBe("aGVsbG8=");
    });

    it("encodes binary bytes as base64", () => {
      const buf = Buffer.from([0x00, 0xff, 0x10, 0x20]);
      expect(serializeValue(buf)).toBe(buf.toString("base64"));
    });

    it("encodes empty Buffer as empty string", () => {
      expect(serializeValue(Buffer.alloc(0))).toBe("");
    });
  });

  describe("plain objects", () => {
    it("recurses through every value", () => {
      const input = {
        id: new Int("1"),
        name: "alice",
        balance: new Numeric("99.99"),
        active: true,
      };
      expect(serializeValue(input)).toEqual({
        id: 1,
        name: "alice",
        balance: "99.99",
        active: true,
      });
    });

    it("handles nested plain objects", () => {
      const input = {
        outer: {
          inner: new Int("9007199254740993"),
        },
      };
      expect(serializeValue(input)).toEqual({
        outer: { inner: "9007199254740993" },
      });
    });

    it("handles objects with a null prototype", () => {
      const input = Object.create(null) as Record<string, unknown>;
      input.n = new Int("5");
      input.s = "x";
      expect(serializeValue(input)).toEqual({ n: 5, s: "x" });
    });

    it("returns an empty object for an empty input object", () => {
      expect(serializeValue({})).toEqual({});
    });
  });

  describe("arrays", () => {
    it("serializes each element via serializeValue", () => {
      const input = [new Int("1"), new Int("2"), new Float(3.5)];
      expect(serializeValue(input)).toEqual([1, 2, 3.5]);
    });

    it("preserves null elements (no coalescing or filtering)", () => {
      const input = [new Int("1"), null, new Int("9007199254740993")];
      expect(serializeValue(input)).toEqual([1, null, "9007199254740993"]);
    });

    it("returns an empty array for empty input", () => {
      expect(serializeValue([])).toEqual([]);
    });

    it("handles nested arrays", () => {
      const input = [[new Int("1"), new Int("2")], [new Int("3")]];
      expect(serializeValue(input)).toEqual([[1, 2], [3]]);
    });
  });

  describe("toJSON fallback", () => {
    it("delegates to toJSON() for SpannerDate", () => {
      const d = new SpannerDate(2024, 0, 15); // 2024-01-15
      const result = serializeValue(d);
      expect(result).toBe(d.toJSON());
      // Sanity-check the format the production code relies on.
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("treats Struct as an array of fields (it extends Array, so the Array branch wins)", () => {
      // Struct extends Array, so it hits the Array.isArray branch and each
      // {name, value} field is recursed into as a plain object. We document
      // this here because it's the *actual* behaviour callers rely on — the
      // toJSON fallback is intentionally never reached for Struct.
      const s = Struct.fromJSON({ a: 1, b: "two", c: new Int("9007199254740993") });
      expect(serializeValue(s)).toEqual([
        { name: "a", value: 1 },
        { name: "b", value: "two" },
        { name: "c", value: "9007199254740993" },
      ]);
    });

    it("delegates to toJSON() for arbitrary class instances exposing toJSON", () => {
      class Custom {
        toJSON() {
          return { kind: "custom", ok: true };
        }
      }
      expect(serializeValue(new Custom())).toEqual({ kind: "custom", ok: true });
    });

    it("returns the value as-is when there is no toJSON and the prototype is not Object", () => {
      class Opaque {
        x = 1;
      }
      const o = new Opaque();
      // Not a plain object, no toJSON — falls through and is returned verbatim.
      // We don't assert structural equality (it'd recurse into our own check),
      // just identity.
      expect(serializeValue(o)).toBe(o);
    });
  });
});
