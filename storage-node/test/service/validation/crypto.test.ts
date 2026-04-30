import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hmacSha256Base64Url,
  isExpired,
  verifySignature,
} from "../../../src/services/validation/crypto";

describe("hmacSha256Base64Url", () => {
  it("returns the expected base64url encoded HMAC signature", () => {
    const signature = hmacSha256Base64Url(
      "bucket=photos&objectKey=picture/a.jpg&method=PUT&exp=1771477681&fileSize=1024",
      "my-secret-key",
    );

    assert.equal(signature, "ceXbI7LADSJHmNN1MqaKw8vVNzVc8QMcWcHZNMbl3J0");
  });

  it("returns the same signature for the same input", () => {
    const data = "bucket=photos&objectKey=picture/a.jpg&method=PUT&exp=1771477681&fileSize=1024";
    const secret = "my-secret-key";

    assert.equal(
      hmacSha256Base64Url(data, secret),
      hmacSha256Base64Url(data, secret),
    );
  });

  it("produces a URL-safe signature without base64 padding", () => {
    const signature = hmacSha256Base64Url(
      "bucket=photos&objectKey=picture/a.jpg&method=PUT&exp=1771477681&fileSize=1024",
      "my-secret-key",
    );

    assert.match(signature, /^[A-Za-z0-9_-]+$/);
    assert.equal(signature.includes("+"), false);
    assert.equal(signature.includes("/"), false);
    assert.equal(signature.includes("="), false);
  });

  it("changes the signature when the input changes", () => {
    const secret = "my-secret-key";
    const baseData = "bucket=photos&objectKey=picture/a.jpg&method=PUT&exp=1771477681&fileSize=1024";
    const changedData = "bucket=photos&objectKey=picture/b.jpg&method=PUT&exp=1771477681&fileSize=1024";

    assert.notEqual(
      hmacSha256Base64Url(baseData, secret),
      hmacSha256Base64Url(changedData, secret),
    );
  });
});

describe("verifySignature", () => {
  const method = "PUT";
  const bucket = "photos";
  const objectKey = "picture/a.jpg";
  const exp = 1771477681;
  const fileSize = "1024";
  const secret = "my-secret-key";
  const validSignature = hmacSha256Base64Url(
    `bucket=${bucket}&objectKey=${objectKey}&method=${method}&exp=${exp}&fileSize=${fileSize}`,
    secret,
  );

  it("returns true for a valid signature", () => {
    assert.equal(
      verifySignature(
        method,
        bucket,
        objectKey,
        exp,
        fileSize,
        validSignature,
        secret,
      ),
      true,
    );
  });

  it("returns false when the signature string differs", () => {
    assert.equal(
      verifySignature(
        method,
        bucket,
        objectKey,
        exp,
        fileSize,
        "invalid-signature",
        secret,
      ),
      false,
    );
  });

  it("returns false when fileSize differs from the signed payload", () => {
    assert.equal(
      verifySignature(
        method,
        bucket,
        objectKey,
        exp,
        "2048",
        validSignature,
        secret,
      ),
      false,
    );
  });

  it("returns false when method differs from the signed payload", () => {
    assert.equal(
      verifySignature(
        "GET",
        bucket,
        objectKey,
        exp,
        fileSize,
        validSignature,
        secret,
      ),
      false,
    );
  });

  it("returns false when objectKey differs from the signed payload", () => {
    assert.equal(
      verifySignature(
        method,
        bucket,
        "picture/b.jpg",
        exp,
        fileSize,
        validSignature,
        secret,
      ),
      false,
    );
  });

  it("returns false when timingSafeEqual cannot compare different-length buffers", () => {
    assert.equal(
      verifySignature(
        method,
        bucket,
        objectKey,
        exp,
        fileSize,
        "short",
        secret,
      ),
      false,
    );
  });
});

describe("isExpired", () => {
  it("returns false when the expiration is in the future", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    try {
      assert.equal(isExpired(1_700_000_001), false);
    } finally {
      Date.now = originalNow;
    }
  });

  it("returns true when the expiration is in the past", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    try {
      assert.equal(isExpired(1_699_999_999), true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("returns false when the expiration equals the current second", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    try {
      assert.equal(isExpired(1_700_000_000), false);
    } finally {
      Date.now = originalNow;
    }
  });
});
