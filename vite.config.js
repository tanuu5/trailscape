import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 本番ビルドだけに入れる CSP。外部への通信は地理院タイル（任意でオン）だけに限る。
// 開発サーバーは HMR の WebSocket を使うので、dev では入れない。
const GSI = 'https://cyberjapandata.gsi.go.jp';
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${GSI}`,
  `connect-src 'self' ${GSI}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  plugins: [
    viteSingleFile(),
    {
      name: 'inject-csp',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          '<!--CSP-->',
          `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        );
      },
    },
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173, strictPort: true },
});
