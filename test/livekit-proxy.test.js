import assert from "node:assert/strict";
import { test } from "node:test";

import { isLiveKitSignalPath } from "../server/lib/livekit-proxy.js";

test("LiveKit proxy accepts only its signaling endpoint", () => {
  assert.equal(isLiveKitSignalPath("/rtc"), true);
  assert.equal(isLiveKitSignalPath("/rtc?access_token=redacted"), true);
  assert.equal(isLiveKitSignalPath("/rtc/validate"), true);
  assert.equal(isLiveKitSignalPath("/mila"), false);
  assert.equal(isLiveKitSignalPath("/hermes/rtc"), false);
});
