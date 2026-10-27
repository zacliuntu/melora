import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("MELODY_DATA_DIR", ROOT / "data")).resolve()


def now():
    return datetime.now(timezone.utc).isoformat()


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATA / "editor.sqlite3", timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init():
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS versions (
                project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
                label TEXT NOT NULL, created_at TEXT NOT NULL, document TEXT NOT NULL,
                PRIMARY KEY(project_id, revision));
            CREATE TABLE IF NOT EXISTS artifacts (
                project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
                data BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(project_id, name));
            CREATE TRIGGER IF NOT EXISTS immutable_project BEFORE UPDATE ON projects
            WHEN json_extract(OLD.document, '$.status') = 'approved'
            BEGIN SELECT RAISE(ABORT, 'confirmed melody is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_artifact BEFORE UPDATE ON artifacts
            BEGIN SELECT RAISE(ABORT, 'artifact is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_artifact_delete BEFORE DELETE ON artifacts
            BEGIN SELECT RAISE(ABORT, 'artifact is immutable'); END;
        """)
        # A single uvicorn process owns the serial transcription worker. Interrupted jobs
        # become retryable, rather than displaying an endless spinner after a restart.
        for row in db.execute("SELECT document FROM projects").fetchall():
            p = json.loads(row[0])
            if p["status"] in ("queued", "transcribing"):
                p.update(status="failed", error="服务重启中断了识别，请重试。")
                put(db, p)


@contextmanager
def transaction():
    db = connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def get(db, pid):
    row = db.execute("SELECT document FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(404, "工程不存在")
    return json.loads(row[0])


def put(db, p):
    p["updated_at"] = now()
    db.execute("UPDATE projects SET document=? WHERE id=?", (json.dumps(p), p["id"]))


def editable(p, revision=None):
    if p["status"] == "approved":
        raise HTTPException(423, "主旋律已确认锁定，不能再修改")
    if p["status"] != "ready":
        raise HTTPException(409, "请等待旋律识别完成")
    if revision is not None and p["revision"] != revision:
        raise HTTPException(409, "版本冲突：其他窗口已修改此工程。请保留本地草稿并重新载入。")


def snapshot(db, p, label):
    p["revision"] += 1
    put(db, p)
    db.execute("INSERT INTO versions VALUES (?, ?, ?, ?, ?)",
               (p["id"], p["revision"], label, now(), json.dumps({"notes": p["notes"], "bpm": p["bpm"]})))
