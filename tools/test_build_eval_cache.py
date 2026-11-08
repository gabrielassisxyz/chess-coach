"""Tests for build_eval_cache.py.

uv run --no-project --with orjson --with pytest pytest tools/test_build_eval_cache.py
"""
import base64
import json
import random
import sqlite3
import subprocess
import sys
from pathlib import Path

import orjson
import pytest

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import build_eval_cache as cache  # noqa: E402

SCRIPT = HERE / "build_eval_cache.py"
GOLDEN = json.loads((HERE / "testdata" / "eval_cache_golden.json").read_text())
ALL_PIECES_FEN = "rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6"


def run(args: list[str], stdin: bytes) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, capture_output=True)


def lines(records: list[dict]) -> bytes:
    return b"".join(orjson.dumps(record) + b"\n" for record in records)


def record(fen: str = "4k3/8/8/8/8/8/8/4K3 w - -", **overrides) -> dict:
    base = {"fen": fen, "evals": [{"depth": 20, "knodes": 10, "pvs": [{"cp": 1, "line": "e1e2"}]}]}
    return {**base, **overrides}


def build_db(tmp_path: Path, records: list[dict]) -> Path:
    transformed = run(["transform"], lines(records))
    assert transformed.returncode == 0, transformed.stderr
    rows = sorted(transformed.stdout.splitlines())
    path = tmp_path / "evals.db"
    loaded = run(["load", str(path)], b"\n".join(rows) + b"\n")
    assert loaded.returncode == 0, loaded.stderr
    return path


def test_hand_derived_bytes() -> None:
    # 3r4/k1P5/P7/1K6/8/8/8/8 w - - worked out on paper: occupancy bits 3, 8, 10, 16, 25 give
    # 0x02010508; the pieces r k P P K are nibbles 9 b 0 0 5 padded with f; white, no castling,
    # no en passant is 15 << 5 = 0x01e0.
    key = bytes.fromhex("0805010200000000" "b9" "00" "f5" "e001")
    # version 1, one set, depth 40, knodes 70000 = 0x00011170, one line of one move, score -35
    # = 0xffdd, b5b4 = (4 * 8 + 1) | (3 * 8 + 1) << 6 = 0x0661.
    value = bytes.fromhex("0101" "28" "70110100" "01" "01" "ddff" "6106")
    source = {"fen": "3r4/k1P5/P7/1K6/8/8/8/8 w - -", "evals": [
        {"depth": 40, "knodes": 70000, "pvs": [{"cp": -35, "line": "b5b4"}]}]}
    assert cache.encode_record(source) == (key, 40, value)


@pytest.mark.parametrize("case", GOLDEN, ids=[case["name"] for case in GOLDEN])
def test_golden_fixture(case: dict) -> None:
    key, depth, value = cache.encode_record(case["input"])
    assert key.hex() == case["key"]
    assert depth == case["depth"]
    assert value.hex() == case["value"]
    assert cache.decode_key(key) == case["input"]["fen"]
    assert cache.decode_value(value) == cache.expected_sets(case["input"])


def test_golden_covers_the_required_shapes() -> None:
    names = {case["name"] for case in GOLDEN}
    assert len(names) == 6
    stored = [cache.decode_value(bytes.fromhex(case["value"])) for case in GOLDEN]
    flat = [line for sets in stored for item in sets for line in item["lines"]]
    assert any(line["mate"] for line in flat)
    assert any(not line["mate"] for line in flat)
    assert any(move[4:] for line in flat for move in line["moves"])
    assert any("e1h1" in line["moves"] for line in flat)
    assert any(not line["moves"] for line in flat)
    assert any(len(sets) == 2 for sets in stored)


@pytest.mark.parametrize(
    "epd",
    [
        "3r4/k1P5/P7/1K6/8/8/8/8 w - -",
        "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R b KQkq -",
        "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b Kq e3",
        ALL_PIECES_FEN,
        "8/8/8/8/8/8/8/8 w - -",
    ],
)
def test_key_round_trip(epd: str) -> None:
    assert cache.decode_key(cache.pack_key(epd)) == epd


def test_all_twelve_pieces_are_in_the_round_trip() -> None:
    assert set(cache.PIECES) <= set(ALL_PIECES_FEN)


def test_castling_bits_follow_kqkq() -> None:
    state = lambda castling: int.from_bytes(cache.pack_key(f"4k3/8/8/8/8/8/8/4K3 w {castling} -")[-2:], "little")  # noqa: E731
    assert [state(c) >> 1 & 15 for c in ("K", "Q", "k", "q", "KQkq", "-")] == [1, 2, 4, 8, 15, 0]


@pytest.mark.parametrize(
    "epd",
    [
        "4k3/8/8/8/8/8/8/4K3 w A -",
        "4k3/8/8/8/8/8/8/4K3 w QK -",
        "4k3/8/8/8/8/8/8/4K3 w KK -",
        "4k3/8/8/8/8/8/8/4K3 w - e4",
        "4k3/8/8/8/8/8/8/4K3 b - e6",
        "4k3/8/8/8/8/8/8/4K3 x - -",
        "4k3/8/8/8/8/8/8/4K3 w -",
        "4k3/8/8/8/8/8/8 w - -",
        "4k4/8/8/8/8/8/8/4K3 w - -",
        "4k3/8/8/8/8/8/8/4X3 w - -",
        "35/8/8/8/8/8/8/4K3 w - -",
    ],
)
def test_unrepresentable_fens_are_refused(epd: str) -> None:
    with pytest.raises(cache.Unrepresentable):
        cache.pack_key(epd)


def test_hex_order_is_byte_order() -> None:
    rng = random.Random(7)
    keys = [bytes(rng.randrange(256) for _ in range(rng.randrange(1, 6))) for _ in range(2000)]
    keys += [b"\x0f", b"\x0f\x00", b"\x10", b"\xa0", b"\x9f\xff"]
    by_text = sorted(key.hex() for key in set(keys))
    assert by_text == [key.hex() for key in sorted(set(keys))]
    assert all(char in "0123456789abcdef" for text in by_text for char in text)


def test_sqlite_blob_order_matches_sorted_hex(tmp_path: Path) -> None:
    rng = random.Random(3)
    keys = {bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12))) for _ in range(500)}
    db = sqlite3.connect(tmp_path / "order.db")
    db.execute("CREATE TABLE t (key BLOB PRIMARY KEY) WITHOUT ROWID")
    db.executemany("INSERT INTO t VALUES (?)", [(key,) for key in keys])
    stored = [row[0].hex() for row in db.execute("SELECT key FROM t ORDER BY key")]
    assert stored == sorted(key.hex() for key in keys)


def evaluation(depth: int, line_count: int) -> dict:
    return {"depth": depth, "knodes": 1, "pvs": [{"cp": n, "line": "e2e4"} for n in range(line_count)]}


def test_deepest_alone_when_it_has_the_most_lines() -> None:
    sets = cache.select_sets({"evals": [evaluation(10, 3), evaluation(30, 3), evaluation(20, 1)]})
    assert [item["depth"] for item in sets] == [30]


def test_second_set_is_the_deepest_with_the_most_lines() -> None:
    sets = cache.select_sets({"evals": [evaluation(40, 1), evaluation(10, 3), evaluation(25, 3), evaluation(30, 2)]})
    assert [(item["depth"], len(item["pvs"])) for item in sets] == [(40, 1), (25, 3)]


def test_value_clamps_and_truncates() -> None:
    big = {"depth": 20, "knodes": 2**40, "pvs": [{"cp": 99999, "line": " ".join(["e2e4"] * 200)},
                                                  {"mate": -99999, "line": "e2e4"}]}
    (stored,) = cache.decode_value(bytes([1, 1]) + cache.pack_set(big))
    assert stored["knodes"] == 2**32 - 1
    assert stored["lines"][0]["score"] == 32767
    assert len(stored["lines"][0]["moves"]) == 127
    assert stored["lines"][1] == {"mate": True, "score": -32768, "moves": ["e2e4"]}


def test_transform_output_shape() -> None:
    result = run(["transform"], lines([record()]))
    assert result.returncode == 0
    hex_key, depth, encoded = result.stdout.decode().rstrip("\n").split("\t")
    key, want_depth, value = cache.encode_record(record())
    assert (hex_key, int(depth), base64.b64decode(encoded)) == (key.hex(), want_depth, value)
    assert b"lines=1 written=1 failed=0" in result.stderr


def test_transform_counts_failures_and_exits_non_zero() -> None:
    bad = record("4k3/8/8/8/8/8/8/4K3 w A -")
    result = run(["transform"], lines([record(), bad, record("4k3/8/8/8/8/8/8/3K4 w - -")]))
    assert result.returncode == 1
    assert len(result.stdout.splitlines()) == 2
    assert b"failed=1" in result.stderr
    assert b"line 2" in result.stderr and b"castling 'A'" in result.stderr


def test_transform_names_only_the_first_ten_failures() -> None:
    result = run(["transform"], lines([record("4k3/8/8/8/8/8/8/4K3 w A -")] * 14))
    assert result.returncode == 1
    assert result.stderr.count(b"transform: failed line") == 10
    assert b"failed=14" in result.stderr


def test_transform_fails_on_a_line_that_is_not_json() -> None:
    result = run(["transform"], b"not json\n" + lines([record()]))
    assert result.returncode == 1
    assert len(result.stdout.splitlines()) == 1


def test_load_sets_pragmas_before_the_table(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    statements: list[str] = []
    real_connect = sqlite3.connect

    def traced(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(sqlite3, "connect", traced)
    cache._open_new_database(str(tmp_path / "new.db")).close()
    squashed = [" ".join(text.split()).lower().rstrip(";") for text in statements]
    table = next(i for i, text in enumerate(squashed) if text.startswith("create table evals"))
    for pragma in ("pragma page_size = 4096", "pragma journal_mode = off", "pragma synchronous = off"):
        assert squashed.index(pragma) < table


def test_load_refuses_an_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "evals.db"
    path.write_bytes(b"keep me")
    result = run(["load", str(path)], b"")
    assert result.returncode != 0
    assert b"already exists" in result.stderr
    assert path.read_bytes() == b"keep me"


def test_load_writes_rows_with_source_zero(tmp_path: Path) -> None:
    records = [case["input"] for case in GOLDEN]
    path = build_db(tmp_path, records)
    db = sqlite3.connect(path)
    assert db.execute("PRAGMA page_size").fetchone() == (4096,)
    rows = db.execute("SELECT key, source, depth, value FROM evals ORDER BY key").fetchall()
    assert len(rows) == len(GOLDEN)
    assert {row[1] for row in rows} == {0}
    by_key = {bytes.fromhex(case["key"]): case for case in GOLDEN}
    for key, _source, depth, value in rows:
        assert (depth, value.hex()) == (by_key[key]["depth"], by_key[key]["value"])


def test_load_reports_rows_and_seconds(tmp_path: Path) -> None:
    transformed = run(["transform"], lines([record()]))
    result = run(["load", str(tmp_path / "evals.db")], transformed.stdout)
    assert result.returncode == 0
    out = result.stdout.decode()
    assert "rows=1\n" in out and "seconds=" in out


def test_verify_passes_on_a_good_database(tmp_path: Path) -> None:
    records = [case["input"] for case in GOLDEN]
    path = build_db(tmp_path, records)
    result = run(["verify", str(path)], lines(records))
    assert result.returncode == 0, result.stderr
    assert b"verified=6" in result.stdout


def rewrite_value(path: Path, fen: str, change) -> None:
    key = cache.pack_key(fen)
    db = sqlite3.connect(path)
    (value,) = db.execute("SELECT value FROM evals WHERE key = ?", (key,)).fetchone()
    db.execute("UPDATE evals SET value = ? WHERE key = ?", (change(bytearray(value)), key))
    db.commit()
    db.close()


def verify_case(tmp_path: Path, name: str, change) -> subprocess.CompletedProcess:
    case = next(case for case in GOLDEN if case["name"] == name)
    path = build_db(tmp_path, [case["input"]])
    rewrite_value(path, case["input"]["fen"], change)
    return run(["verify", str(path)], lines([case["input"]]))


def test_verify_catches_a_cleared_mate_flag(tmp_path: Path) -> None:
    def clear_flag(value: bytearray) -> bytearray:
        value[8] &= 0x7F  # line header: 2 bytes of value header, 6 of set header
        return value

    result = verify_case(tmp_path, "mate line", clear_flag)
    assert result.returncode == 1
    assert b"mate" in result.stderr


def test_verify_catches_a_changed_promotion(tmp_path: Path) -> None:
    def drop_promotion(value: bytearray) -> bytearray:
        value[12] &= 0x0F  # high byte of the first move of the first line
        return value

    result = verify_case(tmp_path, "promotion", drop_promotion)
    assert result.returncode == 1
    assert b"moves" in result.stderr


def test_verify_catches_a_missing_second_set(tmp_path: Path) -> None:
    def keep_first_set(value: bytearray) -> bytearray:
        first_end = 2 + 6 + 3 + 2 * 2  # one line of two moves
        return bytearray([1, 1]) + value[2:first_end]

    result = verify_case(tmp_path, "deepest set has fewer lines", keep_first_set)
    assert result.returncode == 1
    assert b"1 sets stored, 2 selected" in result.stderr


def test_verify_catches_a_wrong_depth_column(tmp_path: Path) -> None:
    case = GOLDEN[0]
    path = build_db(tmp_path, [case["input"]])
    db = sqlite3.connect(path)
    db.execute("UPDATE evals SET depth = depth + 1")
    db.commit()
    db.close()
    result = run(["verify", str(path)], lines([case["input"]]))
    assert result.returncode == 1
    assert b"depth column" in result.stderr


def test_verify_names_a_missing_row(tmp_path: Path) -> None:
    path = build_db(tmp_path, [record()])
    absent = record("4k3/8/8/8/8/8/8/3K4 w - -")
    result = run(["verify", str(path)], lines([absent]))
    assert result.returncode == 1
    assert b"row missing" in result.stderr and b"3K4" in result.stderr


def test_verify_stops_at_the_first_mismatch(tmp_path: Path) -> None:
    path = build_db(tmp_path, [record()])
    absent = record("4k3/8/8/8/8/8/8/3K4 w - -")
    result = run(["verify", str(path)], lines([absent, record()]))
    assert result.returncode == 1
    assert b"input line 1" in result.stderr
    assert b"verified=" not in result.stdout


def test_verify_checks_the_source_not_the_encoder(tmp_path: Path) -> None:
    path = build_db(tmp_path, [record()])
    changed = record(evals=[{"depth": 20, "knodes": 10, "pvs": [{"cp": 2, "line": "e1e2"}]}])
    result = run(["verify", str(path)], lines([changed]))
    assert result.returncode == 1
    assert b"score" in result.stderr


def test_unknown_command_prints_usage() -> None:
    result = run([], b"")
    assert result.returncode != 0 and b"usage" in result.stderr
