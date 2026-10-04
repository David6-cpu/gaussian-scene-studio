import { expect, test } from "vitest";
import * as loader from "./load";
const read = loader.readExactAsset;
test("asset reader accepts only the declared number of bytes across stream chunks", async () => {
  const r = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3, 4]));
        c.close();
      },
    }),
  );
  expect([...(await read(r, 4))]).toEqual([1, 2, 3, 4]);
  await expect(read(new Response(new Uint8Array(3)), 4)).rejects.toThrow(
    /长度/,
  );
});
test("asset reader cancels an oversized stream before allocating a full response buffer", async () => {
  let cancelled = false;
  const r = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(read(r, 4)).rejects.toThrow(/长度/);
  expect(cancelled).toBe(true);
  await expect(read(new Response("x"), 250001 * 32)).rejects.toThrow(/预算/);
});
