/** Allocate at most one declared <=250k SPLAT buffer; cancel unexpected larger bodies. */
export async function readExactAsset(
  response: Response,
  expectedBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > 250000 * 32
  )
    throw new Error("素材读取超出预算");
  if (!response.body) throw new Error("素材读取失败：空响应");
  const reader = response.body.getReader(),
    bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > expectedBytes)
        throw new Error("素材长度不匹配");
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== expectedBytes) throw new Error("素材长度不匹配");
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
