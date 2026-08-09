# Mountain backgrounds for the session card

Eight peaks, chosen deterministically per session so re-sharing the same
session always renders the same image. Neutral names on purpose: the source
renders are not labelled, and a filename asserting "half-dome" would be a claim
nobody checked.

**Source:** supplied by the project owner as 1254×1254 PNGs, converted here with
`cwebp -q 80 -m 6`. 21.9 MB of PNG became 1.09 MB of WebP — bundling the
originals would have added more weight than the rest of the app's assets
combined.

**1254 px is the ceiling, and it constrains the export.** A 1:1 card fills a
3× phone (1170 px) with room to spare. A 9:16 story at 1080×1920 does not:
filling it would mean upscaling ~1.5× and cropping the sides hard, which is
worst for the peaks nearest the centre. The story composition therefore anchors
the photo in the upper portion at native scale rather than bleeding it
full-frame — which is also what the reference design does, so the constraint and
the design agree.

Re-export at ≥2160 px if a full-bleed story is ever wanted.
