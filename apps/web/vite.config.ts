import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = new URL(process.env.CALLMATE_DEV_API_TARGET || 'http://127.0.0.1:3000');
const apiOrigin = new URL(apiTarget);
// The private API accepts loopback hosts; Compose reaches it by service name.
if (['server', 'zeus-llama'].includes(apiOrigin.hostname)) apiOrigin.hostname = 'localhost';
function localUiOrigin(origin: string, host: string | undefined) {
  try {
    const from = new URL(origin); const ui = new URL(`http://${host}`);
    return from.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(from.hostname)
      && ['localhost', '127.0.0.1'].includes(ui.hostname) && from.port === ui.port;
  } catch { return false; }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget.href,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            outgoing.setHeader('host', apiOrigin.host);
            // Rewrite only our local UI origins; leave untrusted origins for rejection.
            if (incoming.headers.origin && localUiOrigin(incoming.headers.origin, incoming.headers.host)) {
              outgoing.setHeader('origin', apiOrigin.origin);
            }
          });
        },
      },
    },
  },
});
