from __future__ import annotations

import json
from pathlib import Path

import pytest

from hotelwatch import cli
from hotelwatch.models import Reading
from hotelwatch.providers.base import ProviderError


class FakeProvider:
    name = "swiftbook"

    def __init__(self, price: float | None = 40036.0, fail: bool = False) -> None:
        self.price = price
        self.fail = fail
        self.calls = 0

    def fetch(self, target) -> Reading:
        self.calls += 1
        if self.fail:
            raise ProviderError("boom")
        return Reading(
            target_id=target.id,
            observed_at=Reading.now(),
            currency="INR",
            available=True,
            price=self.price,
            price_after_tax=self.price * 1.18,
            plan_name="Plan",
            plan_rate_id="1",
            promo=None,
        )

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return True


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    watchlist = {
        "targets": [
            {
                "id": "riva",
                "name": "Riva",
                "url": "https://www.swiftbook.io/inst/#home?propertyId=x==&JDRN=Y",
                "provider": "swiftbook",
                "room": "Room",
                "check_in": "2027-01-29",
                "check_out": "2027-02-02",
                "alert_below": 36000,
            }
        ],
        "scans": [
            {
                "id": "riva-scan",
                "name": "Riva scan",
                "url": "https://www.swiftbook.io/inst/#home?propertyId=x==&JDRN=Y",
                "provider": "swiftbook",
                "room": "Room",
                "nights": 4,
                "from": "2026-12-01",
                "to": "2026-12-03",
            }
        ],
    }
    (tmp_path / "watchlist.json").write_text(json.dumps(watchlist))
    return tmp_path


def _argv(ws: Path, *extra: str) -> list[str]:
    return [
        "--watchlist", str(ws / "watchlist.json"),
        "--history", str(ws / "data/history.jsonl"),
        "--scans", str(ws / "data/scans.jsonl"),
        "--site", str(ws / "docs/data/history.json"),
        *extra,
    ]  # fmt: skip


def test_validate_ok(workspace: Path, capsys) -> None:
    assert cli.main(_argv(workspace, "validate")) == 0
    out = capsys.readouterr().out
    assert "1 target(s), 1 scan(s) valid" in out
    assert "3 dates" in out


def test_validate_bad_json(workspace: Path) -> None:
    (workspace / "watchlist.json").write_text("{nope")
    assert cli.main(_argv(workspace, "validate")) == 2


def test_run_writes_history_site_and_alerts(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(price=35000.0))
    monkeypatch.setattr(cli, "send_ntfy", lambda alerts: False)
    alerts = workspace / "data/alerts.json"
    rc = cli.main(_argv(workspace, "run", "--alerts", str(alerts)))
    assert rc == 0
    assert (workspace / "data/history.jsonl").read_text().count("\n") == 1
    data = json.loads((workspace / "docs/data/history.json").read_text())
    assert data["targets"][0]["stats"]["current"] == 35000.0
    assert data["targets"][0]["stats"]["below_alert"] is True
    assert data["scans"][0]["latest"] is None
    assert [a["kind"] for a in json.loads(alerts.read_text())] == ["threshold"]


def test_run_clears_stale_alerts_file(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(price=40036.0))
    alerts = workspace / "data/alerts.json"
    alerts.parent.mkdir()
    alerts.write_text("[]")
    cli.main(_argv(workspace, "run", "--alerts", str(alerts)))
    assert not alerts.exists()


def test_run_dry_run_writes_nothing(workspace: Path, monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider())
    rc = cli.main(_argv(workspace, "run", "--dry-run"))
    assert rc == 0
    assert not (workspace / "data/history.jsonl").exists()
    assert '"price": 40036.0' in capsys.readouterr().out


def test_run_reports_provider_failure(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(fail=True))
    rc = cli.main(_argv(workspace, "run"))
    assert rc == 1
    assert not (workspace / "data/history.jsonl").exists()
    # The site file is still rebuilt so the page never goes stale on a transient failure.
    assert (workspace / "docs/data/history.json").exists()


def test_scan_writes_results_and_site(workspace: Path, monkeypatch) -> None:
    provider = FakeProvider(price=50000.0)
    monkeypatch.setattr(cli, "get_provider", lambda name: provider)
    rc = cli.main(_argv(workspace, "scan"))
    assert rc == 0
    assert provider.calls == 3
    rows = (workspace / "data/scans.jsonl").read_text().strip().splitlines()
    assert len(rows) == 1
    data = json.loads((workspace / "docs/data/history.json").read_text())
    block = data["scans"][0]
    assert len(block["latest"]["points"]) == 3
    assert block["history"][0]["min"] == 50000.0


def test_scan_only_filter_and_unknown_id(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider())
    assert cli.main(_argv(workspace, "scan", "--only", "nope")) == 2
    assert cli.main(_argv(workspace, "scan", "--only", "riva-scan", "--dry-run")) == 0
    assert not (workspace / "data/scans.jsonl").exists()


def test_scan_with_no_data_fails(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(fail=True))
    assert cli.main(_argv(workspace, "scan")) == 1


def test_build_writes_site_from_stored_data(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(price=35000.0))
    monkeypatch.setattr(cli, "send_ntfy", lambda alerts: False)
    assert cli.main(_argv(workspace, "run", "--alerts", str(workspace / "a.json"))) == 0
    site = workspace / "docs/data/history.json"
    site.unlink()
    assert cli.main(_argv(workspace, "build")) == 0
    data = json.loads(site.read_text())
    assert data["targets"][0]["stats"]["current"] == 35000.0


def test_show_without_history(workspace: Path, capsys) -> None:
    assert cli.main(_argv(workspace, "show")) == 0
    out = capsys.readouterr().out
    assert "no readings yet" in out
    assert "no results yet" in out
