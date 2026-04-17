import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:18000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:18000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-core': ['react', 'react-dom', 'react-router-dom'],
          'antd': ['antd', '@ant-design/icons'],
          'reactflow': ['reactflow'],
          'markdown': ['react-markdown', 'remark-gfm', 'rehype-raw'],
        },
      },
    },
  },
});
