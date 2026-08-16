import importlib.util
import os
import tempfile
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "y2y2_engine.py"
os.environ.setdefault("Y2Y2_DOWNLOAD_DIR", str(Path(tempfile.gettempdir()) / "y2y2-tests-download"))
os.environ.setdefault("Y2Y2_APP_DATA_DIR", str(Path(tempfile.gettempdir()) / "y2y2-tests-data"))
spec = importlib.util.spec_from_file_location("y2y2_engine", MODULE)
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)


def test_validate_youtube_url():
    assert engine.validate_source_url("https://youtu.be/abc") == "https://youtu.be/abc"
    try:
        engine.validate_source_url("https://example.com/video")
    except ValueError:
        pass
    else:
        raise AssertionError("non-YouTube URL accepted")


def test_safe_filename_blocks_reserved_and_traversal():
    assert ".." not in engine.safe_filename("../evil")
    assert engine.safe_filename("CON") == "_CON"
    assert "/" not in engine.safe_filename("a/b")
    assert "\\" not in engine.safe_filename("a\\b")


def test_store_partial_failure_is_independent(tmp_path):
    store = engine.EngineStore(tmp_path)
    a = store.create_job({"url": "https://youtu.be/a", "title": "A", "mediaType": "mp3", "quality": 256})
    b = store.create_job({"url": "https://youtu.be/b", "title": "B", "mediaType": "mp4", "quality": 720})
    store.update(a["id"], status="ready", stage="saved", output_path=str(tmp_path / "a.mp3"), filename="a.mp3", size_bytes=1)
    store.update(b["id"], status="failed", stage="failed", error="synthetic failure")
    assert store.get_job(a["id"])["status"] == "ready"
    assert store.get_job(b["id"])["status"] == "failed"


def test_retry_only_changes_target_job(tmp_path):
    store = engine.EngineStore(tmp_path)
    a = store.create_job({"url": "https://youtu.be/a", "title": "A", "mediaType": "mp3", "quality": 256})
    b = store.create_job({"url": "https://youtu.be/b", "title": "B", "mediaType": "mp3", "quality": 320})
    store.update(a["id"], status="failed", stage="failed", error="x")
    store.update(b["id"], status="ready", stage="saved")
    store.retry(a["id"])
    assert store.get_job(a["id"])["status"] == "queued"
    assert store.get_job(b["id"])["status"] == "ready"
