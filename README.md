This project turns MIDI files into music box paper strips. It produces DXF files that can be cut
automatically (e.g. with a Silhouette Cameo in Silhouette Studio) for 15 and 30 note paper-strip
music boxes. Paper width, notes supported by the box, hole size, speed and sheet size are configurable.

This project also includes a simple MIDI File parser based on the information available at https://www.midi.org/ and http://www.somascape.org/midi/tech/mfile.html. The parser by itself can be used to analyze MIDI files, convert MIDI to JSON, convert delta times to absolute seconds, etc.

## Available Scripts

Requires Node.js 20.19 or newer. Install dependencies with `npm install`, then:

| Command | Description |
| --- | --- |
| `npm run dev` (or `npm start`) | Runs the app in development mode at http://localhost:5173 |
| `npm test` | Runs all tests once (`npm run test:watch` to keep watching) |
| `npm run lint` | Lints the code with ESLint |
| `npm run typecheck` | Type-checks the code with TypeScript |
| `npm run build` | Type-checks and builds the app for production to the `dist` folder |
| `npm run preview` | Serves the production build locally |
| `npm run deploy` | Lints, tests, builds and publishes `dist` to GitHub Pages |

The build uses relative paths, so `dist` can be served from any folder.

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3).
See the [LICENSE](./LICENSE) file for the full text.

### Modifications

This project is a modified version of [musicbox-svg](https://github.com/SabinT/musicbox-svg),
originally created by SabinT. It is distributed here under the terms
of the GPLv3, as required by the original license.

Changes made by [JoshJD11] on [2026-09-27]:
- Added a playback feature to preview the generated melody on a virtual piano before downloading.
- Redesigned the UI for a cleaner, more polished look.
- Replaced SVG export with DXF export, allowing the strip to be cut automatically in free software such as Silhouette Studio.

Changes made by [JoshJD11] on [2026-11-07]:
- MIDI parser: tempo maps across tracks, SysEx and long meta events, SMPTE timing, Note On with velocity 0 treated as Note Off, readable errors for invalid files.
- Out of range notes are transposed to the closest octave; notes too close on the same line are dropped consistently; the piano plays exactly the punched notes.
- Track selection (auto, all tracks merged, or a single track); percussion channel ignored by default.
- Strips are never cut through or too close to a hole, and never exceed the sheet size.
- DXF files are generated directly from the strip geometry.
- Settings validation, resource cleanup in the 3D view and audio player.
- Migrated from Create React App to Vite, Vitest, ESLint 10 and TypeScript 6.
