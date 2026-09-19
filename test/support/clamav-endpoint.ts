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
  readonly response?: 'clean' | 'malware' | 'error' | 'malformed';
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
        socket.end(`ClamAV/1.4.0/27000/${options.signatureDate.toUTCString()}\0`);
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
      const response = options.response ?? 'clean';
      socket.end(
        response === 'clean'
          ? 'stream: OK\0'
          : response === 'malware'
            ? 'stream: Test-Signature FOUND\0'
            : response === 'error'
              ? 'stream: scan ERROR\0'
              : 'not clamav\0',
      );
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
