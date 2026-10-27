import type { Server } from 'node:http';

export function drainHttpServer(server: Server, timeoutMs = 65000): Promise<void> {
  return new Promise((resolve,reject) => {
    // A socket that was active at close() can become idle afterwards.
    const idleTimer=setInterval(()=>server.closeIdleConnections(),100);
    idleTimer.unref();
    const timer=setTimeout(() => {
      clearInterval(idleTimer);
      server.closeAllConnections();
      reject(new Error('HTTP shutdown drain timed out'));
    },timeoutMs);
    timer.unref();
    // Node 20 closes idle keep-alive sockets, but lets in-flight responses finish.
    server.close(error => {
      clearTimeout(timer);
      clearInterval(idleTimer);
      if(error)reject(error);else resolve();
    });
  });
}
