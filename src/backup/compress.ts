/**
 * Compress a string using gzip via Web Streams API
 * Compatible with Cloudflare Workers runtime
 *
 * @param data - String data to compress
 * @returns Compressed data as ArrayBuffer
 */
export async function gzipCompress(data: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });

  const compressed = stream.pipeThrough(new CompressionStream('gzip'));
  return new Response(compressed).arrayBuffer();
}
