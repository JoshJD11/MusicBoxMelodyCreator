/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset paths: the build works from any folder (e.g. GitHub Pages project sites).
  base: "./",
  plugins: [react({ jsxRuntime: "classic" })],
  define: {
    // Some old dependencies of Blueprint 3 (has-symbols via react-popper) use Node's `global`,
    // which webpack used to provide automatically.
    global: "globalThis",
    // Blueprint 3 reads these at runtime to customize its CSS prefix ("bp3" by default);
    // Create React App used to inject them.
    "process.env.BLUEPRINT_NAMESPACE": "undefined",
    "process.env.REACT_APP_BLUEPRINT_NAMESPACE": "undefined",
  },
  css: {
    lightningcss: {
      // Blueprint 3's stylesheet has a few invalid selectors (e.g. "::after.bp3-active").
      // Browsers ignore those rules; let the minifier drop them too instead of failing.
      errorRecovery: true,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/testUtils/**", "src/index.tsx"],
      reporter: ["text", "html"],
      // The modules that decide what is punched and cut must stay thoroughly tested.
      thresholds: {
        "src/model/MidiFile.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "src/utilities/MusicBoxNotes.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/MusicBoxLayout.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/DxfExporter.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/DxfReader.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/SheetDrawing.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // Holes deleted by hand in the preview: what is left is what gets cut.
        "src/utilities/HoleEdits.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // MP3 to MIDI (experimental): what decides the notes that reach the strip.
        "src/utilities/AudioTranscription.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/AudioDecoding.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/utilities/BasicPitchTranscriber.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
