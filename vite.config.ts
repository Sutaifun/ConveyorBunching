/**
 * 只用于 `npm run play` 的本地预览。博客那边有自己的构建，这个文件不会跟去。
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'web',
  // 组件要 import ../src/sim.ts，得让 Vite 能读到 web/ 之外
  server: { fs: { allow: ['..'] }, open: true },
  build: { outDir: '../.preview', emptyOutDir: true },
  plugins: [vue()],
});
