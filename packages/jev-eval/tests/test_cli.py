import json
from pathlib import Path

from jev_eval.cli import build_parser


def invoke(*args: str) -> None:
    parsed = build_parser().parse_args(list(args))
    parsed.func(parsed)


def test_mock_end_to_end() -> None:
    invoke("static")
    invoke("jev", "--mock")
    invoke("jev-ax", "--mock")
    invoke("coverage")
    invoke("cost")
    invoke("report")
    root = Path(__file__).resolve().parents[1]
    report = (root / "reports/report.md").read_text(encoding="utf-8")
    assert "MOCK" in report
    assert "CLI 路径覆盖率" in report
    result = json.loads((root / "reports/jev.json").read_text(encoding="utf-8"))
    assert result["mode"] == "mock"
    assert result["samples"] == 180


def test_live_mode_requires_key(monkeypatch) -> None:
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    parsed = build_parser().parse_args(["jev"])
    try:
        parsed.func(parsed)
    except RuntimeError as exc:
        assert "--mock" in str(exc)
    else:
        raise AssertionError("缺少 key 时不应静默进入 mock")
