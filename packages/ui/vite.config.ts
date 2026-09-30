import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ブラウザが本人のSupabase Authセッションでデータへアクセスする SPA として配信する（4章・11.5）
export default defineConfig({
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), viteReact()],
});
