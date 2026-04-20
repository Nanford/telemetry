import json
import sqlite3
from typing import Optional, Tuple, List, Dict, Any

from app.utils import now_ts


class Spool:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS spool ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "ts INTEGER NOT NULL,"
            "payload TEXT NOT NULL)"
        )
        self.conn.commit()

    def put(self, payload: Dict[str, Any]) -> int:
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO spool(ts,payload) VALUES(?,?)",
            (now_ts(), json.dumps(payload, ensure_ascii=False)),
        )
        self.conn.commit()
        return cur.lastrowid

    def peek(self) -> Optional[Tuple[int, str]]:
        cur = self.conn.cursor()
        cur.execute("SELECT id,payload FROM spool ORDER BY id ASC LIMIT 1")
        row = cur.fetchone()
        return (row[0], row[1]) if row else None

    def peek_batch(self, limit: int = 50) -> List[Tuple[int, str]]:
        cur = self.conn.cursor()
        cur.execute("SELECT id,payload FROM spool ORDER BY id ASC LIMIT ?", (limit,))
        return cur.fetchall()

    def delete(self, row_id: int) -> None:
        self.conn.execute("DELETE FROM spool WHERE id=?", (row_id,))
        self.conn.commit()

    def count(self) -> int:
        cur = self.conn.cursor()
        cur.execute("SELECT COUNT(1) FROM spool")
        return int(cur.fetchone()[0])
