import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// dev 模式下也可直连本地服务（端口 21800 起）。Electron 内运行时优先走 preload 注入的 serverInfo。
const SERVER_PORT = process.env.WORKGREMLIN_PORT || 21800;

/**
 * 读取本地服务 token（每次启动随机生成，写在 ~/.workgremlin/server.json）。
 * 浏览器 dev 模式没有 preload 桥接，拿不到 token 会被 401 / WS 踢下线，
 * 因此由 vite 代理在转发时**动态**注入（每次请求现读，服务端重启换 token 也不用重启 vite）。
 */
function readServerToken() {
  const home = process.env.WORKGREMLIN_HOME || path.join(os.homedir(), '.workgremlin');
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    return typeof info.token === 'string' ? info.token : '';
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // @workgremlin/shared 是 workspace 软链的 CJS 包：dev 下 Vite 会走 /@fs 把它当原生
  // ESM 直接喂给浏览器，导致 `import { avatarOf }` 报 "does not provide an export named"、
  // 首屏全黑。显式预打包让 esbuild 先把 CJS 转成 ESM（生产侧对应 build.commonjsOptions）。
  optimizeDeps: {
    include: ['@workgremlin/shared'],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const token = readServerToken();
            if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
          });
        },
      },
      '/ws': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            const token = readServerToken();
            if (!token) return;
            const sep = proxyReq.path.includes('?') ? '&' : '?';
            proxyReq.path += `${sep}token=${encodeURIComponent(token)}`;
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // @workgremlin/shared 是 workspace 软链，真实路径不在 node_modules 下，
    // 默认的 commonjs include 规则会跳过它，导致 CJS 具名导出（STATE_LABELS 等）在
    // 生产构建中解析失败（dev 因为有 esbuild 预打包所以不报错）。
    commonjsOptions: {
      include: [/node_modules/, /shared/],
      transformMixedEsModules: true,
    },
  },
});
