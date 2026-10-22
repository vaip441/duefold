import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';

export interface ClamAvTestEndpoint {
  readonly host: string;
  readonly port: number;
  readonly requests: () => readonly Uint8Array[];
  close(): Promise<void>;
}
export async function startClamAvTestEndpoint(options: {
  readonly signatureDate: Date;
  readonly response?: 'clean' | 'malware' | 'error' | 'malformed' | 'limit' | 'scan-time';
  readonly stall?: boolean;
  readonly disconnectDuring?: 'version' | 'instream';
}): Promise<ClamAvTestEndpoint> {
  const requests: Uint8Array[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      const request = Buffer.concat(chunks);
      requests.push(request);
      if (options.stall === true) return;
      if (request.subarray(0, 9).toString() === 'zVERSION\0') {
        if (options.disconnectDuring === 'version') {
          socket.destroy();
          return;
        }
        // The real clamd separates the product name from the version with a
        // SPACE: `ClamAV 1.5.4/28129/<date>`. This double previously emitted
        // `ClamAV/1.4.0/...`, which no clamd produces, so the suite validated a
        // parser that rejected every real reply.
        socket.end(`ClamAV 1.5.4/28129/${options.signatureDate.toUTCString()}\0`);
        return;
      }
      if (request.subarray(0, 10).toString() !== 'zINSTREAM\0') {
        socket.end('bad\0');
        return;
      }
      if (options.disconnectDuring === 'instream') {
        socket.destroy();
        return;
      }
      // `limit` and `scan-time` are verbatim clamav-debian:1.5 replies with AlertExceedsMax
      // to a source over MaxFileSize, and to a scan that ran past MaxScanTime.
      const replies = {
        clean: 'stream: OK\0',
        malware: 'stream: Test-Signature FOUND\0',
        error: 'stream: scan ERROR\0',
        malformed: 'not clamav\0',
        limit: 'stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0',
        'scan-time': 'stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND\0',
      };
      socket.end(replies[options.response ?? 'clean']);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('scanner address missing');
  return {
    host: '127.0.0.1',
    port: address.port,
    requests: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
