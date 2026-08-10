import { md5 } from "../md5";

describe("md5 (UTF-8 correctness)", () => {
  it("hashes ASCII input identically to standard MD5 (backward compatible)", () => {
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5("sesame")).toBe("c8dae1c50e092f3d877192fc555b1dcf");
  });

  it("hashes non-ASCII (multi-byte UTF-8) input as the server does", () => {
    // Must hash the UTF-8 bytes, not UTF-16 code units — the latter gives a
    // wrong hash and 401s for international passwords.
    expect(md5("mön")).toBe("473bba104a8e0934879bcc27b86e17be");
    expect(md5("héllo123salt")).toBe("171e20e134fecb7469c9b078759a8846");
  });

  it("handles surrogate pairs (4-byte UTF-8)", () => {
    expect(md5("🎵")).toBe("571a5ba7aec0b965e1f2f6e272a279fa");
  });
});
