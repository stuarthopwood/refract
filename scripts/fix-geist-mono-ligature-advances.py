#!/usr/bin/env python3
"""Make Geist Mono's code ligatures occupy the cells they replace (issue #2058).

Upstream's `liga` lookup merges 2-4 characters into one glyph that keeps a one-cell advance and is
drawn leftwards from its origin (negative left bearing), so a browser paints `===` over the previous
token. Widening each ligature glyph's advance to one cell per replaced character and shifting its
outline right by the same extra width puts the ink exactly where the characters were.

Usage: python scripts/fix-geist-mono-ligature-advances.py [font.woff2]
Idempotent: glyphs whose advance already matches are left alone. Needs `fonttools` and `brotli`.
"""
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

DEFAULT_FONT = Path(__file__).resolve().parent.parent / 'src/renderer/assets/fonts/GeistMono-Variable.woff2'


def ligature_cell_counts(font):
    """Map each ligature glyph to the number of characters it replaces."""
    counts = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for subtable in lookup.SubTable:
            if lookup.LookupType == 7:
                subtable = subtable.ExtSubTable
            if getattr(subtable, 'ligatures', None) is None:
                continue
            for ligatures in subtable.ligatures.values():
                for ligature in ligatures:
                    if ligature.LigGlyph.endswith('.liga'):
                        counts[ligature.LigGlyph] = len(ligature.Component) + 1
    return counts


def shift_glyph(glyph, dx, shifts):
    if glyph.isComposite():
        # A component that is itself a ligature glyph is shifted on its own, so only add the remainder.
        for component in glyph.components:
            component.x += dx - shifts.get(component.glyphName, 0)
    else:
        glyph.coordinates.translate((dx, 0))


def main(path):
    font = TTFont(path)
    cell = font['hmtx']['space'][0]
    glyf = font['glyf']
    hmtx = font['hmtx']
    counts = ligature_cell_counts(font)
    shifts = {name: cell * (cells - 1) for name, cells in counts.items()}
    patched = 0
    for name, cells in counts.items():
        advance, _ = hmtx[name]
        wanted = cell * cells
        if advance == wanted:
            continue
        if advance != cell:
            sys.exit(f'{name}: unexpected advance {advance}')
        glyph = glyf[name]
        shift_glyph(glyph, shifts[name], shifts)
        glyph.recalcBounds(glyf)
        hmtx[name] = (wanted, glyph.xMin)
        patched += 1
    font.save(path)
    print(f'patched {patched} ligature glyphs in {path}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FONT)
