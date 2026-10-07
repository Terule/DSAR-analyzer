#!/usr/bin/env python3
"""Extract a zip archive, repairing entry names that unzip cannot write.

Many export tools store non-ASCII names (for example "Comitê") as UTF-8 bytes
without the zip "UTF-8" flag. `unzip` then writes mangled, invalid-UTF-8 names,
which macOS file systems (APFS, reached through Docker's virtiofs share)
refuse: unzip reports "cannot create ..." and exits 50, which looks like a full
disk. This extractor decodes such names as UTF-8 first, falling back to the zip
standard's DOS code page, and refuses unsafe paths.

Usage: extract_zip.py ARCHIVE TARGET_DIR

Exit codes:
  0   extracted everything
  1   extracted, but skipped some entries (unsafe path, unwritable name)
  2   not a readable zip (corrupt)
  3   entry names cannot be decoded at all (flagged UTF-8 but invalid bytes)
  50  environmental write failure (disk full, read-only, permissions, I/O)
"""
import errno
import hashlib
import os
import stat
import sys
import zipfile
import zlib

MAX_COMPONENT_BYTES = 240
ENVIRONMENTAL = {errno.ENOSPC, errno.EDQUOT, errno.EROFS, errno.EACCES, errno.EPERM, errno.EIO}


def decode_name(info: zipfile.ZipInfo) -> str:
    if info.flag_bits & 0x800:
        return info.filename  # flagged UTF-8: zipfile already decoded it
    try:
        return info.orig_filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.orig_filename  # a genuine DOS code page name


def shorten(component: str) -> str:
    if len(component.encode("utf-8")) <= MAX_COMPONENT_BYTES:
        return component
    stem, ext = os.path.splitext(component)
    if len(ext.encode("utf-8")) > 20:
        stem, ext = component, ""
    tag = "~" + hashlib.sha1(component.encode("utf-8")).hexdigest()[:6]
    room = MAX_COMPONENT_BYTES - len(ext.encode("utf-8")) - len(tag)
    return stem.encode("utf-8")[:room].decode("utf-8", errors="ignore") + tag + ext


def safe_parts(name: str):
    parts = []
    for part in name.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == ".." or "\x00" in part or (len(part) == 2 and part[1] == ":"):
            return None
        parts.append(shorten(part))
    if name.replace("\\", "/").startswith("/"):
        return None
    return parts or None


def open_zip(archive: str) -> zipfile.ZipFile:
    """Newer Pythons decode unflagged names as UTF-8 and refuse DOS code pages."""
    try:
        return zipfile.ZipFile(archive)
    except UnicodeDecodeError:
        return zipfile.ZipFile(archive, metadata_encoding="cp437")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    archive, target = sys.argv[1], sys.argv[2]
    root = os.path.realpath(target)
    os.makedirs(root, exist_ok=True)
    skipped = 0
    try:
        with open_zip(archive) as zf:
            for info in zf.infolist():
                name = decode_name(info)
                parts = safe_parts(name)
                if parts is None:
                    print(f"skipped unsafe entry: {name!r}", file=sys.stderr)
                    skipped += 1
                    continue
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    continue  # never create links from an archive
                destination = os.path.join(root, *parts)
                if os.path.commonpath([root, os.path.realpath(destination)]) != root:
                    print(f"skipped unsafe entry: {name!r}", file=sys.stderr)
                    skipped += 1
                    continue
                try:
                    if name.endswith("/") or info.is_dir():
                        os.makedirs(destination, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(destination), exist_ok=True)
                    with zf.open(info) as source, open(destination, "wb") as out:
                        while True:
                            block = source.read(1024 * 1024)
                            if not block:
                                break
                            out.write(block)
                    stamp = __import__("time").mktime(info.date_time + (0, 0, -1))
                    os.utime(destination, (stamp, stamp))
                except OSError as error:
                    if error.errno in ENVIRONMENTAL:
                        print(f"write failed ({error}): {name!r}", file=sys.stderr)
                        return 50
                    print(f"skipped unwritable entry {name!r}: {error}", file=sys.stderr)
                    skipped += 1
    except UnicodeDecodeError as error:
        print(f"entry names cannot be decoded: {error}", file=sys.stderr)
        return 3
    except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as error:
        print(f"unreadable archive: {error}", file=sys.stderr)
        return 2
    except FileNotFoundError:
        print("archive not found", file=sys.stderr)
        return 2
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main())
