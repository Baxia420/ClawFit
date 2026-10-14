# Exercise source ledger — reviewed 2026-10-13

## Adopted text: hasaneyldrm/exercises-dataset

Source: https://github.com/hasaneyldrm/exercises-dataset
Input: `data/exercises.json` from main, SHA-256
`656634224b8977b99a6d765470ee123260d4979715eaa4e7c0b7c8bb0d79f93d`.
License: https://github.com/hasaneyldrm/exercises-dataset/blob/main/LICENSE
MIT, Copyright (c) 2026 Hasan Emir Yıldırım, explicitly covers structure and
instruction text/translations. Full notice retained alongside the data and at
`/exercise-media/text-license.txt`. MIT permits redistribution/modification with
that copyright/permission notice. The upstream license expressly EXCLUDES media.

Only IDs, English names/steps, target/secondary muscles, equipment and source body
category were read into the importer. `image`, `gif_url`, `media_id`, and media
attribution fields were discarded. No images/videos from this repository were
fetched. Names are initial-capitalized; muscle groups mapped to ClawFit's existing
enum; a small original alias table is added for common names. IDs remain upstream
IDs with an `edb:` namespace. Text remains supplied dataset guidance, not a clinical
assessment; classifications are limited to source evidence.

## Adopted stills: Everkinetic via wger

Metadata: https://wger.de/api/v2/exerciseinfo/?limit=1000&language=2
License registry: https://wger.de/api/v2/license/
Images individually list `license: 1` (CC BY-SA 3.0), `license_author: Everkinetic`.
License: https://creativecommons.org/licenses/by-sa/3.0/

The explicit reviewed mapping covers 19 catalogue exercises. The 38 raster files
are downloaded unchanged, not hotlinked, and retain individual hashes, original
URLs, wger exercise/image IDs and author in `docs/licenses/exercise-media.json`.
Per-image metadata can be checked at `https://wger.de/api/v2/exerciseimage/<id>/`.
Attribution/source/license links are displayed in the UI. Copies and any future
adaptations of those images remain CC BY-SA 3.0; indicate any modifications.
The app's surrounding original code is a separate work. These stills show exercise
positions; they are not videos. No whole wger source-code or text import is used.
Images with absent authors, AI flags, unknown licenses, or external derivative
sources were excluded; other media was not blanket-approved from a repository badge.

## Considered, not imported

- OpenGym: https://github.com/DuarteSantos8/openGym/blob/main/NOTICE.md
  AGPL-3.0 application code, but Gym visual assets have separate restricted rights.
  No OpenGym code/text/assets or converted MuscleMap paths copied; no media used as
  input to image generation. ClawFit reuses its own existing original body diagram.
- yuhonas/free-exercise-db: https://github.com/yuhonas/free-exercise-db
  advertises Unlicense for its JSON and images; derived from wrkout/exercises.json.
  Upstream image provenance questions remain open; the repository badge alone was
  insufficient for this task. No data or images from this source are bundled.
- Other wger media: per-record licenses/authorship vary; excluded unless explicitly
  selected above. A Creative Commons label on user-submitted metadata does not
  establish rights for unrelated assets. No live API dependency is introduced.

Do not claim coverage of 5,600 exercises or demonstrations for all 1,324 entries.
Expanding coverage requires independently cleared media and a reviewed mapping.
