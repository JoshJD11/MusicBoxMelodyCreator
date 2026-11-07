# MusicBoxMelodyCreator

Aplicación web (React + TypeScript) que convierte archivos MIDI en **tiras de papel perforado para cajas
musicales de mecanismo de papel** (perfiles de 15 y 30 notas). Genera archivos **DXF** que se cortan con
una Silhouette Cameo 5 en Silhouette Studio, y permite escuchar con un piano sintetizado exactamente lo
que se va a perforar.

Fork GPLv3 de [SabinT/musicbox-svg](https://github.com/SabinT/musicbox-svg). El proyecto está en la raíz
del repositorio. El archivo `notes` contiene apuntes del usuario sobre el corte (presión, profundidad,
tamaños de hoja). No lo borres. `.claude/skills/` tiene las skills del proyecto (vitest,
webapp-testing, vercel-react-best-practices, typescript-advanced-types, find-skills), fijadas en
`skills-lock.json`.

## Precisión ante todo

Lo que sale de aquí se corta en papel físico. Un error de décimas de milímetro rompe la tira o hace que
una nota no suene. Por eso:

- Cualquier cambio en el parser, la extracción de notas, la paginación, la geometría o el DXF debe
  conservar los invariantes de `MusicBoxLayout.test.ts`:
  - cada agujero queda completo dentro de su tira, al menos a `CUT_CLEARANCE_MM` (0.5 mm) de un corte;
  - nada se sale de la hoja, incluida la lengüeta de las juntas tipo puzzle;
  - la posición absoluta de cada agujero en la cinta completa es `(t − inicio) × mm/s`.
- Si un cambio debe dejar la salida igual, compara el DXF de los 3 `samples/` antes y después.
- La vista previa SVG y el DXF salen de **la misma geometría** (`ISheet`). No generes uno a partir del otro.
- El piano reproduce **exactamente** las notas perforadas (`extractMusicBoxNotes`). No tiene lógica propia.
- `$INSUNITS=4` (mm) y las capas `CUT`/`HOLES` del DXF se mantienen a propósito: el flujo de Silhouette
  funciona así.
- El usuario quiere que, antes de cada cambio, se le explique **cómo se hacía antes y cómo se hará
  ahora**, y que se le pregunte antes de modificar comportamientos.

## Comandos

Requiere Node ≥ 20.19.

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo (Vite) en http://localhost:5173 |
| `npm test` | Todos los tests (Vitest + jsdom); `npm run test:watch` para modo vigilancia |
| `npm run test:coverage` | Tests + cobertura; falla si los módulos críticos bajan de su umbral |
| `npm run lint` / `npm run typecheck` | ESLint 10 (typescript-eslint, react-hooks) / `tsc --noEmit` |
| `npm run build` | Type-check y build de producción en `dist/` (rutas relativas, `base: './'`) |
| `npm run preview` | Sirve `dist/`. Reinícialo si vuelves a hacer build (cachea los archivos). |
| `npm run deploy` | lint + cobertura + build y publica `dist/` en GitHub Pages |

## Cómo funciona (flujo de datos)

```
archivo .mid
  └─ model/MidiFile.ts          parser SMF: eventos con absTicks → mapa de tempos → absTimeSeconds
      └─ utilities/MusicBoxNotes.ts   pistas (auto/todas/una), NoteOn vel>0, sin percusión (canal 10),
         │                            transposición a la octava más cercana, descarta notas a ≤ minNoteGap
         │                            del agujero anterior en la misma línea
         ├─ utilities/MusicBoxMidi.ts → PianoPlayer.ts (Web Audio): vista previa sonora
         └─ utilities/MusicBoxLayout.ts  paginateNotes → buildStripGeometry → buildSheets (mm, y hacia abajo)
             ├─ components/MusicBoxSvg.tsx   vista previa (un <svg> por hoja)
             └─ utilities/DxfExporter.ts     DXF R12 por hoja (y invertida respecto al SVG)
```

- **Parser** (`MidiFile.ts`): formatos 0, 1 y 2; timing métrico y SMPTE; SysEx y meta de longitud
  variable; running status. Si el archivo es inválido o está truncado, lanza `Error` con un mensaje
  legible. Nunca parsea un chunk incompleto.
- **Notas** (`MusicBoxNotes.ts`): `'auto'` usa la pista 1 en archivos tipo 1 si tiene notas y, si no, la
  primera pista con notas. La transposición solo mueve octavas; si no hay octava posible, la nota se
  descarta y se informa. Si dos notas quedan a la misma distancia, se elige la más grave.
  Si dos notas caen en la misma línea a ≤ `minNoteGap`, gana la **voz principal**: primero la pista
  principal (al mezclar pistas), luego la de mayor velocidad y, si empatan, la primera. Es decisión
  del usuario: no usar "la más aguda". La transposición es nota por nota; la transposición global
  automática se descartó por decisión del usuario.
- **Paginación** (`MusicBoxLayout.ts`): la nota entra en la tira si `t + r + 0.5 mm ≤ fin`. El corte se
  pone en el punto medio entre notas y, si ahí no cabe, en un hueco anterior; si no hay hueco, da error.
  Con juntas tipo puzzle se reservan 2 mm. Tiras por hoja: `floor((alto + 10) / (anchoPapel + 10))`.
  Con tamaño 0 (sin límite), la hoja se ajusta al contenido.
- **Líneas de nota**: la nota más aguda queda arriba, a `(anchoPapel − anchoContenido) / 2` del borde
  superior.
- **Espejo vertical** (`mirrorVertically`, desactivado por defecto): refleja cada tira dentro de su
  propia franja (`y → anchoPapel − y`) para no tener que voltearla en Silhouette. Se aplica a la
  geometría, así que la vista previa y el DXF coinciden.
- **Audio** (`PianoPlayer.ts`): ganancia 1.0 → limitador (−12 dB, 20:1, ataque 1 ms) → altavoces. Está
  medido con render offline de los samples: +13 a +16 dB respecto a la versión original y pico ≤ 0.82,
  sin saturación. Si cambias la cadena, vuelve a medir.
- **UI**: siempre en **una sola columna** (preferencia del usuario). `MusicBoxSheetGenerator.tsx` (componente raíz). Los editores de perfil y formato validan con
  `validateMusicBoxProfile` / `validateFormatOptions`. La vista 3D (Fischer Price) es experimental,
  usa datos de ejemplo y se carga en diferido (`React.lazy`, three.js en un chunk aparte).

## Convenciones

- TypeScript `strict`. Lógica en funciones puras dentro de `model/` y `utilities/`, testeadas sin React.
  Los componentes solo presentan.
- Un test por módulo, junto al archivo (`*.test.ts[x]`). `src/testUtils/midiBuilder.ts` construye MIDI
  byte a byte para los tests. Los samples reales están en `samples/`.
- `MusicBoxSheetGenerator.test.tsx` es la prueba de extremo a extremo: carga un MIDI desde la interfaz
  y comprueba que el DXF descargado es idéntico al calculado.
- Se usan React 16 + Blueprint 3 a propósito. Pasar a React 18 obliga a migrar Blueprint 3 → 5, que
  cambia la interfaz. `vite.config.ts` define `global: "globalThis"` (dependencia vieja de Blueprint) y
  define `process.env.BLUEPRINT_NAMESPACE` (sin él, `npm run dev` queda en blanco) y activa
  `lightningcss.errorRecovery` (Blueprint 3 tiene 10 selectores CSS inválidos que los navegadores ya
  ignoran). No quites ninguno.
- Verifica los cambios visibles en Chrome real con la skill `webapp-testing`
  (`python3 .claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 5173 -- …`).
  Los tests en jsdom no detectaron dos fallos que solo aparecían en el navegador.
- Las unidades son mm y segundos. Los nombres de campo lo indican (`…Mm`, `…Seconds`).
