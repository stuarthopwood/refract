# Bundled font provenance

All fonts here are licensed under the SIL Open Font License 1.1 (see `OFL.txt`, copyright The Geist Project Authors).

| File | Source | Version |
| --- | --- | --- |
| `Geist-Variable.woff2` | `geist` npm package, Geist variable font | geist 1.8.2 |
| `GeistMono-Variable.woff2` | https://github.com/vercel/geist-font, `fonts/GeistMono/webfonts/GeistMono[wght].woff2`, last changed in commit `a0a06a3d916dcf92fe96f12051a124f89056b36a` (release v1.8.2) | v1.8.2 |

Upstream `GeistMono-Variable.woff2` SHA-256: `AFAACC4C5FBBA89D2EBF7A02DC4070208540874592A5504D57175782FE893101`.

The Geist Mono file comes from the upstream repository, not the npm package, because the npm package's Geist Mono has no `liga` feature (issue #1246).

## Local modification (issue #2058)

Upstream's `liga` lookup replaces 2 to 4 characters with one glyph that keeps a one-cell advance and is drawn leftwards from its origin, so a browser paints `===` over the preceding token. The bundled file is upstream's with `scripts/fix-geist-mono-ligature-advances.py` applied: it widens each `*.liga` glyph's advance to one cell per replaced character and shifts its outline right by the same amount, so the ink lands exactly where the characters were. Nothing else is changed. To re-derive it, fetch the upstream file above (check the hash) and run the script on it.

Patched `GeistMono-Variable.woff2` SHA-256: `BA9F3FAFF9ABC66C6745C0197634ED407B09F579C94FFB685ADDE8EECF6211E4`.
