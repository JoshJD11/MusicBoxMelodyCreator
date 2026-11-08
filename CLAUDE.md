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
  - el bloque de tiras de cada hoja está centrado y las filas quedan a ≥ 10 mm entre sí;
  - la posición absoluta de cada agujero en la cinta completa es `(t − inicio) × mm/s`.
- Si un cambio debe dejar la salida igual, compara el DXF de los 3 `samples/` antes y después.
- La vista previa se dibuja **leyendo los mismos documentos DXF que se descargan** (`parseDxf`). Se
  calculan una sola vez (`getLayout` en `MusicBoxSheetGenerator`). Lo que se ve es el archivo.
  Comprobado: es idéntica píxel a píxel a la vista previa anterior, que se dibujaba desde la geometría.
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
             └─ utilities/SheetDrawing.ts    drawSheet: hoja con la orientación elegida (horizontal / vertical)
                 └─ utilities/DxfExporter.ts DXF R12 por hoja (y invertida)
                 ├─ descarga: esos mismos textos DXF
                 └─ utilities/DxfReader.ts → components/DxfPreview.tsx  vista previa dibujada
                                              leyendo el DXF (un <svg> por hoja)
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
- **Centrado en el DXF** (`buildSheets`): las tiras de cada hoja se centran como **un bloque** en ambos
  ejes (decisión del usuario): todas se desplazan igual (`offsetXMm`, `offsetYMm`), siguen alineadas por
  su inicio y a 10 mm entre filas. Es un desplazamiento rígido: no cambia distancias entre agujeros,
  cortes ni tiras. Se calcula en coordenadas de cinta, así que vale para horizontal y vertical, con o sin
  espejo (el espejo refleja cada tira dentro de su franja). Una hoja ajustada al contenido tiene margen 0
  exacto (salida idéntica a la de antes). Sustituye al contorno visual que se probó en la vista previa.
- **Líneas de nota**: la nota más aguda queda arriba, a `(anchoPapel − anchoContenido) / 2` del borde
  superior.
- **Espejo vertical** (`mirrorVertically`, desactivado por defecto): refleja cada tira dentro de su
  propia franja (`y → anchoPapel − y`): equivale a voltear cada tira en Silhouette. La etiqueta describe
  el resultado ("lowest note at the top" / "on the right"), no si hace falta voltear. Se aplica a la
  geometría, así que la vista previa y el DXF coinciden.
- **Orientación** (`stripOrientation`; la app arranca en **vertical**, preferencia del usuario; sin
  valor, las funciones puras usan horizontal): `buildSheets` trabaja siempre en
  coordenadas de cinta (x a lo largo, tiras en filas); `drawSheet` produce lo que se corta
  (`layout.drawings`). En horizontal solo baja cada tira a su fila (DXF idéntico byte a byte al de antes).
  En vertical gira cada tira 90° en sentido horario y la pone en su columna, de izquierda a derecha en
  orden: `(x, y) → (columna + anchoPapel − y, x)`. La canción empieza arriba y la nota más aguda queda a
  la derecha (con espejo, a la izquierda). Los campos de tamaño conservan su significado (decisión del
  usuario): `pageWidthMm` es el largo máximo de la tira (alto de la hoja en vertical) y `pageHeightMm` el
  espacio para colocarlas lado a lado (ancho en vertical); el DXF intercambia ancho y alto. Las etiquetas y
  los errores usan `sheetDimensionNames`.
- **Auto-tamaño al cargar un MIDI** (`fitSingleStrip`): cada carga (incluso del mismo archivo)
  pone largo = largo de la canción redondeado hacia arriba al mm (+2 mm si hay juntas puzzle), ancho =
  ancho del papel y borde activado: una sola tira en una hoja de su tamaño. Después el usuario puede
  cambiar los tamaños a mano; no se recalcula hasta la siguiente carga. El editor de Layout incorpora
  esos cambios externos con `rebaseEdits` (los campos cambiados desde fuera toman el valor nuevo y se
  conservan los demás cambios sin aplicar).
- **Agujeros**: 2.0 mm (15 notas) y 2.2 mm (30 notas), 0.2 mm más que el proyecto original (decisión
  del usuario). Los tests con cuentas a mano usan un perfil de prueba con agujeros de 2 mm.
- **Vista previa**: en vertical, el cuadro de las hojas mide como mucho el 75% del alto de la ventana y
  tiene scroll propio, para llegar rápido al final de la página. En horizontal no hay límite. El `<svg>`
  no recorta el trazo de las líneas que caen en el borde de la hoja (solo afecta a la pantalla). Cada hoja
  se centra en el cuadro (las más anchas empiezan a la izquierda para poder desplazarse). No se dibuja
  nada que no esté en el DXF.
- **Audio** (`PianoPlayer.ts`): ganancia 1.0 → limitador (−12 dB, 20:1, ataque 1 ms) → altavoces. Está
  medido con render offline de los samples: +13 a +16 dB respecto a la versión original y pico ≤ 0.82,
  sin saturación. Si cambias la cadena, vuelve a medir.
- **Ajustes con Apply**: los paneles de ajustes se mantienen montados (ocultos) al cambiar de pestaña,
  para que los cambios sin aplicar no se pierdan. Si
  hay cambios sin aplicar se avisa en el panel (Apply / Discard) y junto a Download, porque la vista
  previa, el piano y el DXF usan siempre los valores aplicados. Download se desactiva si la tira no se
  puede generar. Hay tests de regresión de todo esto en `MusicBoxSheetGenerator.test.tsx`.
- **UI**: siempre en **una sola columna** (preferencia del usuario). `MusicBoxSheetGenerator.tsx` (componente raíz). Los editores de perfil y formato validan con
  `validateMusicBoxProfile` / `validateFormatOptions`. Pestañas: MIDI File, Paper/Music Box Settings y
  Layout/Pagination. La vista 3D experimental (disco Fisher-Price con three.js) se eliminó por decisión
  del usuario: el proyecto es solo para tiras de papel.

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
