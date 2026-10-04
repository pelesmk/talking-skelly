#!/usr/bin/env python3
"""Build a macOS .icns file from a complete PNG iconset."""

from pathlib import Path
import struct
import sys


CHUNKS = (
    ("icp4", "icon_16x16.png"),
    ("icp5", "icon_32x32.png"),
    ("icp6", "icon_32x32@2x.png"),
    ("ic07", "icon_128x128.png"),
    ("ic08", "icon_256x256.png"),
    ("ic09", "icon_512x512.png"),
    ("ic10", "icon_512x512@2x.png"),
)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: build-icns.py ICONSET_DIR OUTPUT.icns")

    iconset = Path(sys.argv[1])
    output = Path(sys.argv[2])
    chunks = []

    for chunk_type, filename in CHUNKS:
        png = (iconset / filename).read_bytes()
        chunks.append(chunk_type.encode("ascii") + struct.pack(">I", len(png) + 8) + png)

    body = b"".join(chunks)
    output.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


if __name__ == "__main__":
    main()
