import { test, expect } from "vitest";
import {
  environmentSpz,
  environmentWorld,
  jsonBytes,
} from "../../tests/support/environment-fixture";
import { importEnvironment } from "./asset";
import { encodeEnvironment, decodeEnvironment } from "./bundle";
test("self-contained backup preserves bytes, metadata and camera and rejects corruption", async () => {
  const record = {
    asset: await importEnvironment(
      jsonBytes(environmentWorld()),
      environmentSpz(),
    ),
    camera: {
      position: [5, 4, 8] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    },
    savedAt: "2026-10-07T00:00:00.000Z",
  };
  const bytes = await encodeEnvironment(record);
  expect(await decodeEnvironment(bytes)).toEqual(record);
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] ^= 1;
  await expect(decodeEnvironment(corrupt)).rejects.toThrow();
  await expect(decodeEnvironment(bytes.slice(0, -1))).rejects.toThrow();
  const badLength = bytes.slice();
  new DataView(badLength.buffer).setUint32(8, 1048577, true);
  await expect(decodeEnvironment(badLength)).rejects.toThrow();
});
