This project turns MIDI files into music box paper strips. It produces DXF files that can be cut
automatically (e.g. with a Silhouette Cameo in Silhouette Studio) for 15 and 30 note paper-strip
music boxes. Paper width, notes supported by the box, hole size, speed and sheet size are configurable.

MP3 files are also accepted (**experimental**): their notes are detected in the browser with
Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch-ts) and then follow the same path as a
MIDI file. Automatic detection can miss notes or add false ones, so a MIDI file is always preferable;
if you only have audio, a melody played on piano or a similar single instrument gives the best result.
Sliders let you adjust the detection sensitivity after loading an MP3.

**Try it online:** https://musicboxmelodycreator.vercel.app

This project also includes a simple MIDI File parser based on the information available at https://www.midi.org/ and http://www.somascape.org/midi/tech/mfile.html. The parser by itself can be used to analyze MIDI files, convert MIDI to JSON, convert delta times to absolute seconds, etc.

## Available Scripts

Requires Node.js 20.19 or newer (Node.js 24 LTS recommended; the tests need 22.12+). Install
dependencies with `npm ci`, then:

| Command | Description |
| --- | --- |
| `npm run dev` (or `npm start`) | Runs the app in development mode at http://localhost:5173 |
| `npm test` | Runs all tests once (`npm run test:watch` to keep watching) |
| `npm run lint` | Lints the code with ESLint |
| `npm run typecheck` | Type-checks the code with TypeScript |
| `npm run build` | Type-checks and builds the app for production to the `dist` folder |
| `npm run preview` | Serves the production build locally |
| `npm run deploy` | Lints, tests, builds and publishes `dist` to GitHub Pages (not used by the live site) |

The build uses relative paths, so `dist` can be served from any folder.

## Deployment

The live site is hosted on Vercel and is rebuilt automatically from the `main` branch: every commit
that lands on `main` is published. Other branches and pull requests only get preview deployments,
never the live site.

## Contributing

Contributions are welcome through pull requests. `main` is protected: changes reach it only through a
pull request approved by the maintainer, so fork the repository, push to a branch of your fork and open
a pull request against `main`. Please run `npm run lint` and `npm test` before opening it.

## Desktop shortcut

Run the script for your system once. It checks Node.js (and offers to install Node.js 24 LTS if it is
missing), installs the dependencies and creates a "Music Box Melody Creator" shortcut on the desktop.
Double-clicking the shortcut starts the app and opens it in the browser; closing its window stops it.

- Windows (needs [Git for Windows](https://gitforwindows.org/)): double-click `script_windows.sh`.
- Linux: `bash script_linux.sh`

Run it again if you move the project folder.

## Samples

`samples/happy_birthday.mid` and `samples/You are my sunshine.mid` come from the original project.
`samples/ode_to_joy.mid` is an arrangement of Beethoven's "Ode to Joy" (public domain) made for the
tests of this project. `samples/ode_to_joy.mp3` is that same arrangement rendered with the app's piano
synthesizer, to try the (experimental) MP3 support and compare it with the MIDI file.

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3).
See the [LICENSE](./LICENSE) file for the full text.

### Third-party components

MP3 to MIDI uses [Basic Pitch](https://github.com/spotify/basic-pitch-ts) (code and model) by Spotify
and [TensorFlow.js](https://github.com/tensorflow/tfjs) by Google, both under the Apache License 2.0,
which is compatible with the GPLv3.

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
- Settings validation and resource cleanup in the audio player.
- Migrated from Create React App to Vite, Vitest, ESLint 10 and TypeScript 6.
- The preview is drawn by reading back the same DXF files that are downloaded.

Changes made by [JoshJD11] on [2026-11-08]:
- Vertical strip orientation, automatic sheet size that fits the song on a single strip, and strips centered as a block on each sheet.
- Holes 0.2 mm larger than in the original project (2.0 mm for 15 notes, 2.2 mm for 30 notes).
- Removed the experimental 3D disc view.
- Desktop shortcut scripts for Windows and Linux.
- Replaced a copyrighted sample MIDI with a public domain one.

Changes made by [JoshJD11] on [2026-11-09]:
- Experimental MP3 support: notes detected in the browser with Spotify's Basic Pitch (no server), with
  sensitivity sliders, then laid out like a MIDI file. Default settings chosen by measuring the
  punched holes against the original MIDI files of the samples. The silence before the first note of
  an MP3 is removed, so the strip doesn't start with blank paper.
- The buttons above the preview are no longer cut off on phones.
