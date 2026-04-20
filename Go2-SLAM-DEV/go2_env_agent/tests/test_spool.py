import os
import sys
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.storage.spool import Spool


def _make_spool():
    return Spool(":memory:")


class TestSpoolBasic:
    def test_put_returns_id(self):
        s = _make_spool()
        rid = s.put({"a": 1})
        assert rid >= 1

    def test_put_increments(self):
        s = _make_spool()
        r1 = s.put({"a": 1})
        r2 = s.put({"b": 2})
        assert r2 > r1

    def test_peek_returns_oldest(self):
        s = _make_spool()
        s.put({"order": 1})
        s.put({"order": 2})
        row = s.peek()
        assert row is not None
        payload = json.loads(row[1])
        assert payload["order"] == 1

    def test_delete_removes(self):
        s = _make_spool()
        rid = s.put({"x": 1})
        s.delete(rid)
        assert s.peek() is None

    def test_count(self):
        s = _make_spool()
        assert s.count() == 0
        s.put({"a": 1})
        s.put({"b": 2})
        assert s.count() == 2
        s.delete(s.peek()[0])
        assert s.count() == 1


class TestSpoolEmpty:
    def test_peek_empty(self):
        s = _make_spool()
        assert s.peek() is None

    def test_count_empty(self):
        s = _make_spool()
        assert s.count() == 0


class TestSpoolBatch:
    def test_peek_batch(self):
        s = _make_spool()
        for i in range(10):
            s.put({"i": i})
        batch = s.peek_batch(limit=3)
        assert len(batch) == 3
        assert json.loads(batch[0][1])["i"] == 0
        assert json.loads(batch[2][1])["i"] == 2

    def test_peek_batch_fewer_than_limit(self):
        s = _make_spool()
        s.put({"x": 1})
        batch = s.peek_batch(limit=100)
        assert len(batch) == 1
