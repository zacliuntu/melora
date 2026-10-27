import hashlib
import io
import json
import stat
import xml.etree.ElementTree as ET
from uuid import uuid4

import pretty_midi
import pytest
from fastapi.testclient import TestClient
from music21 import converter

from backend import store
from backend.app import app
from backend.exports import render


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path)
    store.init()
    # TestClient without lifespan: no real worker needs to be stopped between tests.
    return TestClient(app)


def create(client, notes=None):
    pid = uuid4().hex
    p = dict(id=pid, name="API test melody", status="ready", revision=0,
             duration=8.0, waveform=[], bpm=120, notes=notes or [
                 dict(id="a", pitch=60, start=.173, end=2.716, velocity=99),
                 dict(id="b", pitch=64, start=1.045, end=1.897, velocity=88),
                 dict(id="c", pitch=67, start=4.218, end=4.789, velocity=80),
             ], source_sha256="source-test", created_at=store.now(), updated_at=store.now(), master=None)
    (store.DATA / pid).mkdir()
    with store.transaction() as db:
        db.execute("INSERT INTO projects VALUES (?, ?)", (pid, json.dumps(p)))
        store.snapshot(db, p, "initial")
    return p


def test_validation_conflicts_history_and_confirm_gate(client):
    p = create(client)
    url = f'/api/projects/{p["id"]}'
    body = dict(expected_revision=1, notes=p["notes"], bpm=120)
    assert client.post(url + "/arrange").status_code == 409
    assert client.get(url + "/handoff").status_code == 409
    assert client.get(url + "/exports/master_melody.mid").status_code == 409
    assert client.post(url + "/confirm", json={"expected_revision": 1, "human_confirmed": False}).status_code == 422
    for changes in ({"end": 9}, {"end": 0.174}, {"pitch": 128}, {"start": -1}):
        bad = [{**p["notes"][0], **changes}]
        assert client.put(url + '/notes', json={**body, "notes": bad}).status_code == 422
    assert client.put(url + '/notes', json={**body, "notes": [p["notes"][0]] * 2}).status_code == 422
    body["notes"][0]["pitch"] = 62
    saved = client.put(url + '/notes', json=body)
    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    assert client.put(url + '/notes', json=body).status_code == 409
    assert client.post(url + '/confirm', json={"expected_revision": 1, "human_confirmed": True}).status_code == 409
    restored = client.post(url + '/restore', json={"expected_revision": 2, "version": 1}).json()
    assert restored["revision"] == 3
    assert restored["notes"][0]["pitch"] == 60
    assert len(client.get(url + '/versions').json()) == 3


def test_locked_artifacts_are_readonly_and_immutable(client):
    p = create(client)
    url = f'/api/projects/{p["id"]}'
    payload = {"expected_revision": 1, "human_confirmed": True}
    response = client.post(url + '/confirm', json=payload)
    assert response.status_code == 200, response.text
    master = response.json()["master"]
    for name, digest in master["files"].items():
        result = client.get(url + '/exports/' + name)
        assert hashlib.sha256(result.content).hexdigest() == digest
        path = store.DATA / p["id"] / 'master' / name
        assert stat.S_IMODE(path.stat().st_mode) == 0o444
        assert path.read_bytes() == result.content
    assert client.post(url + '/confirm', json=payload).json()["master"] == master
    assert client.put(url + '/notes', json={"expected_revision": 1, "notes": [], "bpm": 120}).status_code == 423
    assert client.post(url + '/restore', json={"expected_revision": 1, "version": 1}).status_code == 423
    assert client.post(url + '/transcribe').status_code == 423
    assert client.get(url + '/handoff').status_code == 200
    assert client.post(url + '/arrange').status_code == 501
    with pytest.raises(Exception, match='immutable'):
        with store.transaction() as db:
            store.put(db, response.json())


def test_export_roundtrip_preserves_seconds_overlaps_rests_and_ties(client):
    p = create(client)
    p["bpm"] = 93
    files = render(p)
    midi = pretty_midi.PrettyMIDI(io.BytesIO(files['master_melody.mid']))
    actual = sorted(midi.instruments[0].notes, key=lambda n: n.start)
    for before, after in zip(p["notes"], actual):
        assert before['pitch'] == after.pitch
        assert before['start'] == pytest.approx(after.start, abs=.001)
        assert before['end'] == pytest.approx(after.end, abs=.001)
    root = ET.fromstring(files['master_melody.musicxml'])
    assert root.find('.//sound').get('tempo') == '93'
    assert root.find('.//tie[@type="start"]') is not None
    # Independently parse with music21, strip ties, and verify positions/durations.
    score = converter.parseData(files['master_melody.musicxml'].decode(), format='musicxml')
    parsed = score.stripTies().flatten().notes
    assert len(parsed) == len(p['notes'])
    for before, after in zip(p['notes'], sorted(parsed, key=lambda n: n.offset)):
        assert before['pitch'] == after.pitch.midi
        assert before['start'] == pytest.approx(float(after.offset) * 60 / p['bpm'], abs=.001)
        assert before['end'] - before['start'] == pytest.approx(float(after.quarterLength) * 60 / p['bpm'], abs=.001)


def test_export_failure_does_not_lock_project(client, monkeypatch):
    p = create(client)
    from backend import app as app_module
    def fail(_):
        raise RuntimeError('disk/export unavailable')
    monkeypatch.setattr(app_module, 'render', fail)
    url = f'/api/projects/{p["id"]}'
    assert client.post(url + '/confirm', json={"expected_revision": 1, "human_confirmed": True}).status_code == 500
    assert client.get(url).json()['status'] == 'ready'
    assert not (store.DATA / p['id'] / 'master').exists()


def test_restart_marks_interrupted_jobs_retryable(client):
    p = create(client)
    p['status'] = 'transcribing'
    with store.transaction() as db:
        store.put(db, p)
    store.init()
    assert client.get(f'/api/projects/{p["id"]}').json()['status'] == 'failed'
