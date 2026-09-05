"""One grouping rule shared by session lists and measurement statistics."""
from ..models import Session as SessionModel


def source_predicate(source: str):
    if source == "real":
        return SessionModel.input_source.in_(("ble", "websocket"))
    if source in ("simulation", "unknown"):
        return SessionModel.input_source == source
    return True


def source_group(source: str) -> str:
    return "real" if source in ("ble", "websocket") else source
