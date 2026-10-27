import json
import logging
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import store
from .exports import render
from .models import Confirm, Restore, Save
from .transcription import sha256, transcribe

log = logging.getLogger(__name__)
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="basic-pitch")


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield
    worker.shutdown(wait=True)


app = FastAPI(title="Melora · 拾律", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"status": "ok", "stage": "melody-review", "arrangement_enabled": False}


@app.get("/api/projects")
def projects():
    with store.connect() as db:
        rows = [json.loads(r[0]) for r in db.execute("SELECT document FROM projects")]
    return [{k: p.get(k) for k in ("id", "name", "status", "updated_at", "revision")}
            for p in sorted(rows, key=lambda p: p["updated_at"], reverse=True)]


@app.post("/api/projects", status_code=202)
async def upload(file: UploadFile):
    pid = uuid4().hex
    folder = store.DATA / pid
    folder.mkdir(parents=True)
    try:
        size = 0
        import hashlib
        digest = hashlib.sha256()
        with (folder / "original").open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 100 * 1024 * 1024:
                    raise HTTPException(413, "上传限制为 100 MB")
                output.write(chunk)
                digest.update(chunk)
        if size == 0:
            raise HTTPException(422, "音频文件为空")
        p = dict(id=pid, name=(file.filename or "原创哼唱")[:180], status="queued", revision=0,
                 duration=0, waveform=[], notes=[], bpm=120, created_at=store.now(),
                 updated_at=store.now(), source_sha256=digest.hexdigest(), error=None, master=None)
        with store.transaction() as db:
            db.execute("INSERT INTO projects VALUES (?, ?)", (pid, json.dumps(p)))
        worker.submit(transcribe, pid)
        return p
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    finally:
        await file.close()


@app.get("/api/projects/{pid}")
def project(pid: str):
    with store.connect() as db:
        return store.get(db, pid)


@app.post("/api/projects/{pid}/transcribe", status_code=202)
def retry(pid: str):
    with store.transaction() as db:
        p = store.get(db, pid)
        if p["status"] == "approved":
            raise HTTPException(423, "主旋律已确认锁定")
        if p["status"] != "failed":
            raise HTTPException(409, "只允许重试失败的识别任务，已编辑旋律不能被识别覆盖")
        p.update(status="queued", error=None)
        store.put(db, p)
    worker.submit(transcribe, pid)
    return p


def validate_notes(p, notes):
    if len({n.id for n in notes}) != len(notes):
        raise HTTPException(422, "音符 ID 不能重复")
    if any(n.end > p["duration"] + 0.000001 for n in notes):
        raise HTTPException(422, "音符不能超出原始音频时间轴")


@app.put("/api/projects/{pid}/notes")
def save(pid: str, body: Save):
    with store.transaction() as db:
        p = store.get(db, pid)
        store.editable(p, body.expected_revision)
        validate_notes(p, body.notes)
        notes = [n.model_dump() for n in body.notes]
        if p["notes"] != notes or p["bpm"] != body.bpm:
            p.update(notes=notes, bpm=body.bpm)
            store.snapshot(db, p, "编辑自动保存")
        return p


@app.get("/api/projects/{pid}/versions")
def versions(pid: str):
    with store.connect() as db:
        store.get(db, pid)
        return [dict(r) for r in db.execute(
            "SELECT revision, label, created_at FROM versions WHERE project_id=? ORDER BY revision DESC", (pid,))]


@app.post("/api/projects/{pid}/restore")
def restore(pid: str, body: Restore):
    with store.transaction() as db:
        p = store.get(db, pid)
        store.editable(p, body.expected_revision)
        row = db.execute("SELECT document FROM versions WHERE project_id=? AND revision=?",
                         (pid, body.version)).fetchone()
        if not row:
            raise HTTPException(404, "历史版本不存在")
        p.update(json.loads(row[0]))
        store.snapshot(db, p, f"恢复版本 v{body.version}")
        return p


@app.get("/api/projects/{pid}/audio")
def audio(pid: str):
    with store.connect() as db:
        p = store.get(db, pid)
    if p["status"] not in ("ready", "approved"):
        raise HTTPException(409, "音频正在准备中")
    return FileResponse(store.DATA / p["id"] / "audio.wav", media_type="audio/wav")


@app.post("/api/projects/{pid}/confirm")
def confirm(pid: str, body: Confirm):
    with store.transaction() as db:
        p = store.get(db, pid)
        if not body.human_confirmed:
            raise HTTPException(422, "需要人工试听并明确确认")
        if p["status"] == "approved":
            return p  # Network retries are idempotent; never regenerate an export.
        store.editable(p, body.expected_revision)
        if not p["notes"]:
            raise HTTPException(422, "空旋律不能确认")
        try:
            files = render(p)
        except Exception:
            log.exception("Export failed for %s", pid)
            raise HTTPException(500, "乐谱导出失败；工程仍可编辑，请检查音符后重试")
        manifest = dict(project_id=pid, revision=p["revision"], confirmed_at=store.now(),
                        human_confirmed=True, source_sha256=p["source_sha256"], bpm=p["bpm"],
                        note_count=len(p["notes"]), files={n: sha256(b) for n, b in files.items()},
                        musicxml_timing="quarter-note grid 1/10080", arrangement_enabled=False)
        files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
        # SQLite is the authoritative immutable artifact store. The read-only directory
        # is an export mirror, published via rename only after every file is complete.
        temp = store.DATA / pid / (".master-" + uuid4().hex)
        destination = store.DATA / pid / "master"
        temp.mkdir()
        published = False
        try:
            for name, data in files.items():
                path = temp / name
                path.write_bytes(data)
                path.chmod(0o444)
                db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?)", (pid, name, data, sha256(data)))
            # Recover a mirror orphaned by a previous crash before SQLite committed.
            if destination.exists():
                shutil.rmtree(destination)
            os.replace(temp, destination)
            published = True
            p.update(status="approved", master=manifest)
            store.put(db, p)
        except Exception:
            shutil.rmtree(destination if published else temp, ignore_errors=True)
            raise
        return p


@app.get("/api/projects/{pid}/exports/{name}")
def download(pid: str, name: str):
    with store.connect() as db:
        p = store.get(db, pid)
        if p["status"] != "approved":
            raise HTTPException(409, "人工确认前不能导出主旋律")
        row = db.execute("SELECT data, sha256 FROM artifacts WHERE project_id=? AND name=?", (pid, name)).fetchone()
    if not row:
        raise HTTPException(404, "导出文件不存在")
    if sha256(row["data"]) != row["sha256"]:
        raise HTTPException(500, "导出完整性检查失败")
    media = {"mid": "audio/midi", "musicxml": "application/vnd.recordare.musicxml+xml", "json": "application/json"}
    return Response(row["data"], media_type=media.get(name.split(".")[-1], "application/octet-stream"),
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "ETag": f'"{row["sha256"]}"'})


@app.get("/api/projects/{pid}/handoff")
def handoff(pid: str):
    with store.connect() as db:
        p = store.get(db, pid)
    if p["status"] != "approved":
        raise HTTPException(409, "人工确认前不允许进入 AI 编曲")
    return p["master"]


@app.post("/api/projects/{pid}/arrange")
def arrange(pid: str):
    handoff(pid)
    raise HTTPException(501, "当前仅开放旋律编辑阶段，ACE-Step / YuE2 未启用")


dist = store.ROOT / "frontend" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
