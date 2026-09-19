import json
import pytest

from firmware.dongle.protocol import Event, ProtocolError, ReportLimiter, parse_request


def request(route, value):
    return parse_request(route, json.dumps(value))


def test_large_mouse_move_is_split_without_changing_total():
    events = request("/mouse/move", {"dx": 300, "dy": -129})
    assert all(-127 <= event.values[1] <= 127 and -127 <= event.values[2] <= 127 for event in events)
    assert sum(event.values[1] for event in events) == 300
    assert sum(event.values[2] for event in events) == -129


def test_click_key_and_ascii_typing_release_their_state():
    assert request("/mouse/click", {"button": "right", "count": 2})[-1] == Event("mouse", (0, 0, 0, 0))
    assert request("/key/press", {"key": "A", "modifiers": ["cmd"]}) == [
        Event("key", (0x0A, 0x04)), Event("key", (0, 0))]
    assert len(request("/key/type", {"text": "a!\n"})) == 6


def test_unicode_is_rejected_instead_of_typing_wrong_characters():
    with pytest.raises(ProtocolError, match="Unicode"):
        request("/key/type", {"text": "你好"})


def test_macro_preserves_order_and_limits_total_wait():
    events = request("/macro", {"steps": [
        {"action": "mouse.move", "dx": 2, "dy": 3},
        {"delayMs": 50},
        {"action": "key.press", "key": "enter", "modifiers": []},
    ]})
    assert [event.kind for event in events] == ["mouse", "wait", "key", "key"]
    with pytest.raises(ProtocolError, match="总等待"):
        request("/macro", {"steps": [{"delayMs": 5000}, {"delayMs": 5000}, {"delayMs": 1}]})


def test_malformed_and_out_of_range_inputs_fail():
    with pytest.raises(ProtocolError, match="JSON"):
        parse_request("/mouse/move", "{")
    with pytest.raises(ProtocolError, match="dx"):
        request("/mouse/move", {"dx": True, "dy": 0})
    with pytest.raises(ProtocolError, match="count"):
        request("/mouse/click", {"count": 4})


def test_limiter_uses_fifteen_millisecond_slots():
    now = [10.0]
    limiter = ReportLimiter(lambda: now[0])
    event = Event("key", (0, 4))
    assert limiter.wait_seconds(event) == 0
    assert limiter.wait_seconds(event) == pytest.approx(0.015)
    now[0] += 0.010
    assert limiter.wait_seconds(event) == pytest.approx(0.020)
