// Vite `?raw` imports: the file's text, bundled at build time (start.ts serves the runner's client files from the Worker)
declare module "*?raw" { const text: string; export default text; }
interface ImportMeta { readonly env: { readonly DEV?: boolean }; glob(pattern: string | string[], opts: { query?: string; import?: string; eager: true }): Record<string, unknown>; }
// vite.config.ts define: which code this server bundle was built from (src/build.ts)
declare const __KITEBOOK_BUILD__: { version: string; commit: string | null; channel: string; built_at: string } | undefined;
