import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const projectRoot = import.meta.dirname;

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/demo/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/demo/preload/index.ts'),
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(projectRoot, 'src/demo/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'src/demo/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
});
