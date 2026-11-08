#!/usr/bin/env python3
"""Builds the evaluation cache (a SQLite file keyed by position) from the Lichess evaluation file.

Three commands, run as a pipeline; the format and the full command are in tools/README.md.

    transform   JSON lines on stdin -> `hexkey<TAB>depth<TAB>base64value` on stdout
    load <db>   sorted transform output on stdin -> a new SQLite file
    verify <db> JSON lines on stdin -> every one is looked up and compared with its source
"""
import base64
import functools
import os
import sqlite3
import struct
import sys
import time
from typing import Any, Iterable, Optional

import orjson

FORMAT_VERSION = 1
PIECES = "PNBRQKpnbrqk"
PROMOTIONS = {"": 0, "n": 1, "b": 2, "r": 3, "q": 4}
PROMOTION_LETTERS = {number: letter for letter, number in PROMOTIONS.items()}
CASTLING_BITS = "KQkq"
NO_EN_PASSANT = 15
MAX_MOVES_PER_LINE = 127
MAX_KNODES = 2**32 - 1
BATCH = 100_000
PROGRESS_EVERY = 50_000_000
FAILURES_NAMED = 10

# Every castling field the key can hold exactly: "-" or the letters of KQkq in that order.
CASTLING_TEXT = {
    "".join(letter for bit, letter in enumerate(CASTLING_BITS) if mask >> bit & 1) or "-": mask
    for mask in range(16)
}
CASTLING_FROM_MASK = {mask: text for text, mask in CASTLING_TEXT.items()}


class Unrepresentable(Exception):
    """A source line the format cannot store exactly."""


def pack_key(epd: str) -> bytes:
    fields = epd.split(" ")
    if len(fields) != 4:
        raise Unrepresentable(f"expected 4 fields: {epd!r}")
    placement, side, castling, en_passant = fields
    if side not in ("w", "b"):
        raise Unrepresentable(f"side to move {side!r}")
    if castling not in CASTLING_TEXT:
        raise Unrepresentable(f"castling {castling!r}")
    occupancy, nibbles = _scan_placement(placement)
    state = (side == "b") | CASTLING_TEXT[castling] << 1 | _en_passant_file(en_passant, side) << 5
    packed = bytearray(struct.pack("<Q", occupancy))
    for start in range(0, len(nibbles), 2):
        high = nibbles[start + 1] if start + 1 < len(nibbles) else 15
        packed.append(nibbles[start] | high << 4)
    return bytes(packed) + struct.pack("<H", state)


def _scan_placement(placement: str) -> tuple[int, list[int]]:
    ranks = placement.split("/")
    if len(ranks) != 8:
        raise Unrepresentable(f"placement has {len(ranks)} ranks: {placement!r}")
    occupancy = 0
    nibbles: list[int] = []
    index = 0
    for rank in ranks:
        width = 0
        previous_was_digit = False
        for char in rank:
            if char in "12345678":
                if previous_was_digit:
                    raise Unrepresentable(f"adjacent digits in {placement!r}")
                width += int(char)
                index += int(char)
                previous_was_digit = True
                continue
            piece = PIECES.find(char)
            if piece < 0:
                raise Unrepresentable(f"piece {char!r} in {placement!r}")
            occupancy |= 1 << index
            nibbles.append(piece)
            width += 1
            index += 1
            previous_was_digit = False
        if width != 8:
            raise Unrepresentable(f"rank {rank!r} is not 8 wide in {placement!r}")
    return occupancy, nibbles


def _en_passant_file(en_passant: str, side: str) -> int:
    if en_passant == "-":
        return NO_EN_PASSANT
    # The key keeps the file only; the rank follows from the side to move, so any other rank
    # could not be restored and is refused here.
    expected_rank = "6" if side == "w" else "3"
    if len(en_passant) != 2 or en_passant[0] not in "abcdefgh" or en_passant[1] != expected_rank:
        raise Unrepresentable(f"en passant {en_passant!r} with {side} to move")
    return ord(en_passant[0]) - 97


def decode_key(key: bytes) -> str:
    """The four-field FEN text a key was built from."""
    occupancy = struct.unpack_from("<Q", key, 0)[0]
    (state,) = struct.unpack_from("<H", key, len(key) - 2)
    count = bin(occupancy).count("1")
    pieces = []
    for number in range(count):
        byte = key[8 + number // 2]
        pieces.append(PIECES[byte >> 4 if number % 2 else byte & 15])
    ranks = []
    seen = 0
    for rank in range(8):
        text = ""
        empty = 0
        for file in range(8):
            if occupancy >> (rank * 8 + file) & 1:
                text += (str(empty) if empty else "") + pieces[seen]
                seen += 1
                empty = 0
            else:
                empty += 1
        ranks.append(text + (str(empty) if empty else ""))
    side = "b" if state & 1 else "w"
    castling = CASTLING_FROM_MASK[state >> 1 & 15]
    file_number = state >> 5 & 15
    en_passant = "-" if file_number == NO_EN_PASSANT else chr(97 + file_number) + ("6" if side == "w" else "3")
    return f"{'/'.join(ranks)} {side} {castling} {en_passant}"


@functools.lru_cache(maxsize=None)
def pack_move(uci: str) -> bytes:
    if len(uci) not in (4, 5) or uci[4:] not in PROMOTIONS:
        raise Unrepresentable(f"move {uci!r}")
    squares = []
    for text in (uci[:2], uci[2:4]):
        if text[0] not in "abcdefgh" or text[1] not in "12345678":
            raise Unrepresentable(f"move {uci!r}")
        squares.append(ord(text[0]) - 97 + (ord(text[1]) - 49) * 8)
    return struct.pack("<H", squares[0] | squares[1] << 6 | PROMOTIONS[uci[4:]] << 12)


def unpack_move(packed: int) -> str:
    def name(square: int) -> str:
        return chr(97 + square % 8) + chr(49 + square // 8)

    return name(packed & 63) + name(packed >> 6 & 63) + PROMOTION_LETTERS[packed >> 12 & 7]


def pack_set(item: dict[str, Any]) -> bytes:
    depth, pvs = item["depth"], item["pvs"]
    if not 0 <= depth <= 255 or len(pvs) > 255:
        raise Unrepresentable(f"depth {depth} with {len(pvs)} lines")
    out = bytearray(struct.pack("<BIB", depth, min(item["knodes"], MAX_KNODES), len(pvs)))
    for pv in pvs:
        is_mate = "mate" in pv
        if not is_mate and "cp" not in pv:
            raise Unrepresentable("line with neither cp nor mate")
        score = max(-32768, min(32767, pv["mate"] if is_mate else pv["cp"]))
        moves = pv["line"].split()[:MAX_MOVES_PER_LINE]
        out += struct.pack("<Bh", len(moves) | (0x80 if is_mate else 0), score)
        for uci in moves:
            out += pack_move(uci)
    return bytes(out)


def select_sets(record: dict[str, Any]) -> list[dict[str, Any]]:
    """The deepest evaluation, then the deepest of those with the most lines when it has more."""
    evals = record["evals"]
    if not evals:
        raise Unrepresentable("no evaluations")
    deepest = max(evals, key=lambda item: item["depth"])
    most = max(len(item["pvs"]) for item in evals)
    if most <= len(deepest["pvs"]):
        return [deepest]
    wider = max((item for item in evals if len(item["pvs"]) == most), key=lambda item: item["depth"])
    return [deepest, wider]


def encode_record(record: dict[str, Any]) -> tuple[bytes, int, bytes]:
    """Key, depth column and value for one source record."""
    key = pack_key(record["fen"])
    sets = select_sets(record)
    value = bytes([FORMAT_VERSION, len(sets)]) + b"".join(pack_set(item) for item in sets)
    return key, sets[0]["depth"], value


def decode_value(value: bytes) -> list[dict[str, Any]]:
    """The stored sets, each `{depth, knodes, lines: [{mate, score, moves}]}`, moves as UCI text."""
    if value[0] != FORMAT_VERSION:
        raise ValueError(f"unknown value version {value[0]}")
    offset = 2
    sets = []
    for _ in range(value[1]):
        depth, knodes, line_count = struct.unpack_from("<BIB", value, offset)
        offset += 6
        lines = []
        for _ in range(line_count):
            head, score = struct.unpack_from("<Bh", value, offset)
            offset += 3
            count = head & 127
            moves = [unpack_move(m) for m in struct.unpack_from(f"<{count}H", value, offset)]
            offset += 2 * count
            lines.append({"mate": bool(head & 128), "score": score, "moves": moves})
        sets.append({"depth": depth, "knodes": knodes, "lines": lines})
    if offset != len(value):
        raise ValueError(f"{len(value) - offset} trailing bytes")
    return sets


def expected_sets(record: dict[str, Any]) -> list[dict[str, Any]]:
    """What decode_value must return for a source record, computed from the source text."""
    result = []
    for item in select_sets(record):
        lines = []
        for pv in item["pvs"]:
            is_mate = "mate" in pv
            score = pv["mate"] if is_mate else pv["cp"]
            lines.append({
                "mate": is_mate,
                "score": max(-32768, min(32767, score)),
                "moves": pv["line"].split()[:MAX_MOVES_PER_LINE],
            })
        result.append({"depth": item["depth"], "knodes": min(item["knodes"], MAX_KNODES), "lines": lines})
    return result


def transform(stdin: Iterable[bytes], stdout: Any, stderr: Any) -> int:
    total = 0
    failures: list[str] = []
    failed = 0
    for number, raw in enumerate(stdin, 1):
        total += 1
        try:
            key, depth, value = encode_record(orjson.loads(raw))
        except (Unrepresentable, orjson.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            failed += 1
            if len(failures) < FAILURES_NAMED:
                failures.append(f"line {number}: {type(error).__name__}: {error}")
            continue
        stdout.write(f"{key.hex()}\t{depth}\t{base64.b64encode(value).decode()}\n")
    stderr.write(f"transform: lines={total} written={total - failed} failed={failed}\n")
    for failure in failures:
        stderr.write(f"transform: failed {failure}\n")
    return 1 if failed else 0


def _open_new_database(path: str) -> sqlite3.Connection:
    if os.path.exists(path):
        raise SystemExit(f"load: {path} already exists, refusing to touch it")
    db = sqlite3.connect(path)
    # The page size only takes effect before the first table, and OFF/OFF trade crash safety
    # for speed: a failed build is deleted and rerun, never repaired.
    db.executescript(
        """
        PRAGMA page_size = 4096;
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE evals (
          key BLOB PRIMARY KEY,
          source INTEGER NOT NULL,
          depth INTEGER NOT NULL,
          value BLOB NOT NULL
        ) WITHOUT ROWID;
        """
    )
    return db


def load(path: str, stdin: Iterable[bytes], stdout: Any, stderr: Any) -> int:
    db = _open_new_database(path)
    started = time.time()
    batch: list[tuple[bytes, int, int, bytes]] = []
    total = 0
    for raw in stdin:
        hex_key, depth, encoded = raw.rstrip(b"\n").split(b"\t")
        batch.append((bytes.fromhex(hex_key.decode()), 0, int(depth), base64.b64decode(encoded)))
        total += 1
        if len(batch) == BATCH:
            _flush(db, batch)
        if total % PROGRESS_EVERY == 0:
            stderr.write(f"load: rows={total} seconds={time.time() - started:.0f}\n")
            stderr.flush()
    _flush(db, batch)
    db.close()
    stdout.write(f"rows={total}\nseconds={time.time() - started:.1f}\n")
    return 0


def _flush(db: sqlite3.Connection, batch: list[tuple[bytes, int, int, bytes]]) -> None:
    if not batch:
        return
    db.executemany("INSERT INTO evals (key, source, depth, value) VALUES (?, ?, ?, ?)", batch)
    db.commit()
    batch.clear()


def _mismatch(record: dict[str, Any], key: bytes, db: sqlite3.Connection) -> Optional[str]:
    row = db.execute("SELECT source, depth, value FROM evals WHERE key = ?", (key,)).fetchone()
    if row is None:
        return "row missing"
    _source, depth, value = row
    sets = select_sets(record)
    if depth != sets[0]["depth"]:
        return f"depth column {depth}, source {sets[0]['depth']}"
    stored = decode_value(value)
    wanted = expected_sets(record)
    if len(stored) != len(wanted):
        return f"{len(stored)} sets stored, {len(wanted)} selected from the source"
    for index, (got, want) in enumerate(zip(stored, wanted)):
        for field in ("depth", "knodes"):
            if got[field] != want[field]:
                return f"set {index} {field} {got[field]}, source {want[field]}"
        if len(got["lines"]) != len(want["lines"]):
            return f"set {index} has {len(got['lines'])} lines, source {len(want['lines'])}"
        for number, (g, w) in enumerate(zip(got["lines"], want["lines"])):
            for field in ("mate", "score", "moves"):
                if g[field] != w[field]:
                    return f"set {index} line {number} {field} {g[field]!r}, source {w[field]!r}"
    return None


def verify(path: str, stdin: Iterable[bytes], stdout: Any, stderr: Any) -> int:
    if not os.path.exists(path):
        raise SystemExit(f"verify: {path} does not exist")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    checked = 0
    for number, raw in enumerate(stdin, 1):
        record = orjson.loads(raw)
        try:
            key = pack_key(record["fen"])
            problem = _mismatch(record, key, db)
            if problem is None and decode_key(key) != record["fen"]:
                problem = f"key decodes to {decode_key(key)!r}"
        except Unrepresentable as error:
            problem = f"not representable: {error}"
        if problem:
            stderr.write(f"verify: mismatch on input line {number}, {record['fen']!r}: {problem}\n")
            return 1
        checked += 1
    stdout.write(f"verified={checked}\n")
    return 0


def main(argv: list[str]) -> int:
    usage = "usage: build_eval_cache.py transform | load <new.db> | verify <db>"
    command = argv[1] if len(argv) > 1 else ""
    stdin = sys.stdin.buffer
    if command == "transform" and len(argv) == 2:
        return transform(stdin, sys.stdout, sys.stderr)
    if command == "load" and len(argv) == 3:
        return load(argv[2], stdin, sys.stdout, sys.stderr)
    if command == "verify" and len(argv) == 3:
        return verify(argv[2], stdin, sys.stdout, sys.stderr)
    raise SystemExit(usage)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
