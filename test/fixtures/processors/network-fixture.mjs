import { createConnection } from 'node:net';
const socket = createConnection({ host: '127.0.0.1', port: Number(process.argv[2]) });
socket.once('connect', () => {
  process.stdout.write('reachable');
  socket.destroy();
});
socket.once('error', () => process.stdout.write('denied'));
setTimeout(() => {
  socket.destroy();
  process.exit(0);
}, 100);
