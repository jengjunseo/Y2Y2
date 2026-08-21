import importlib.util
import json
import os
import tempfile
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "relay_agent.py"
spec = importlib.util.spec_from_file_location("relay_agent", MODULE)
relay_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_agent)


def test_identity_store_round_trip(tmp_path):
    store = relay_agent.RelayIdentityStore(tmp_path)
    store.save_credentials("a" * 24, "secret-value-123456789012345678901234", "https://y2-y2.vercel.app")
    restored = relay_agent.RelayIdentityStore(tmp_path).credentials()
    assert restored == ("a" * 24, "secret-value-123456789012345678901234", "https://y2-y2.vercel.app")


def test_active_remote_mapping_persists(tmp_path):
    store = relay_agent.RelayIdentityStore(tmp_path)
    store.map_job("remote-1", "local-1")
    assert relay_agent.RelayIdentityStore(tmp_path).active() == {"remote-1": "local-1"}
    store.unmap_job("remote-1")
    assert relay_agent.RelayIdentityStore(tmp_path).active() == {}


def test_registration_rejects_untrusted_relay_base(tmp_path, monkeypatch):
    class App: pass
    agent = relay_agent.RelayAgent(App(), tmp_path)
    monkeypatch.setenv("Y2Y2_RELAY_BASE_URL", "https://evil.example")
    try:
        agent.register("x" * 24)
    except ValueError as error:
        assert "Untrusted relay" in str(error)
    else:
        raise AssertionError("untrusted relay base accepted")


def test_poll_interval_defaults_are_bounded():
    assert 5 <= relay_agent.POLL_ACTIVE_SECONDS <= 10
    assert 10 <= relay_agent.POLL_IDLE_SECONDS <= 30
    assert relay_agent.HTTP_TIMEOUT[0] > 0
    assert relay_agent.HTTP_TIMEOUT[1] >= relay_agent.HTTP_TIMEOUT[0]
