"""NinaPro DB2 인적사항 표 파서 (stdlib html.parser 만 — 새 무거운 의존성 없음).

DB2 페이지는 게이트되어 있어 로컬 HTML 파일을 인자로 받는다(또는 URL 옵션은 상위 도구가 받은
로컬 사본). subject 표(Subject/Hand/Handedness/Gender/Age/Height/Weight)를 파싱해
data/db2_subjects.json 으로 저장하고 provenance(source_url, retrieved_at, page_sha256) 를 남긴다.
단위 미표기라 meta_confidence='inferred'.

    (venv) PS> python -m scripts.scrape_db2_subjects --html page.html \
                   --source-url https://ninapro.hevs.ch/... --retrieved-at 2026-07-21
"""
from __future__ import annotations

import argparse
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path

# 헤더 텍스트(소문자) → 정규화 키. 여러 표기를 흡수한다.
_HEADER_MAP = {
    "subject": "source_subject_id",
    "subject id": "source_subject_id",
    "id": "source_subject_id",
    "gender": "sex",
    "sex": "sex",
    "age": "age_years",
    "age (years)": "age_years",
    "height": "height_cm",
    "height (cm)": "height_cm",
    "weight": "weight_kg",
    "weight (kg)": "weight_kg",
    "handedness": "handedness",
    "laterality": "handedness",
    "hand": "hand",
}

_INT_KEYS = {"source_subject_id", "age_years", "height_cm", "weight_kg"}


class _TableCollector(HTMLParser):
    """모든 <table> 을 행렬(list[list[str]]) 로 수집."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._rows: list[list[str]] = []
        self._cells: list[str] = []
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._in_table = True
            self._rows = []
        elif tag == "tr" and self._in_table:
            self._in_row = True
            self._cells = []
        elif tag in ("td", "th") and self._in_row:
            self._in_cell = True
            self._buf = []

    def handle_endtag(self, tag):
        if tag == "table" and self._in_table:
            if self._rows:
                self.tables.append(self._rows)
            self._in_table = False
        elif tag == "tr" and self._in_row:
            self._rows.append(self._cells)
            self._in_row = False
        elif tag in ("td", "th") and self._in_cell:
            self._cells.append("".join(self._buf).strip())
            self._in_cell = False

    def handle_data(self, data):
        if self._in_cell:
            self._buf.append(data)


def _normalize_sex(value: str) -> str:
    v = value.strip().lower()
    if v in ("m", "male"):
        return "male"
    if v in ("f", "female"):
        return "female"
    return "unspecified"


def _coerce(key: str, raw: str):
    raw = raw.strip()
    if key in _INT_KEYS:
        try:
            return int(round(float(raw)))
        except ValueError:
            return None
    if key == "sex":
        return _normalize_sex(raw)
    return raw or None


def parse_subjects_html(html_text: str) -> list[dict]:
    """HTML 에서 subject 표를 찾아 정규화된 dict 목록으로 반환. 없으면 ValueError."""
    collector = _TableCollector()
    collector.feed(html_text)

    for rows in collector.tables:
        if not rows:
            continue
        header = [c.strip().lower() for c in rows[0]]
        keys = [_HEADER_MAP.get(h) for h in header]
        if "source_subject_id" not in keys:
            continue  # subject 표가 아님
        out: list[dict] = []
        for row in rows[1:]:
            if not any(cell.strip() for cell in row):
                continue
            rec: dict = {}
            for key, cell in zip(keys, row):
                if key is None:
                    continue
                rec[key] = _coerce(key, cell)
            if rec.get("source_subject_id") is not None:
                out.append(rec)
        return out
    raise ValueError("no subject table (needs a 'Subject' header column) found in HTML")


def build_subjects_doc(html_text: str, *, source_url: str, retrieved_at: str) -> dict:
    """파싱 결과 + provenance 문서를 만든다. page_sha256 은 원본 HTML 바이트 기준."""
    page_sha = hashlib.sha256(html_text.encode("utf-8")).hexdigest()
    subjects = parse_subjects_html(html_text)
    return {
        "provenance": {
            "source_url": source_url,
            "retrieved_at": retrieved_at,
            "page_sha256": page_sha,
            "parser": "scripts.scrape_db2_subjects",
            "meta_confidence": "inferred",  # 단위/표기 미문서 → 추정
        },
        "source_db": "DB2",
        "subjects": subjects,
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Parse NinaPro DB2 subject table into JSON.")
    ap.add_argument("--html", required=True, help="path to a local DB2 page HTML file")
    ap.add_argument("--source-url", required=True, help="original URL (provenance)")
    ap.add_argument("--retrieved-at", required=True, help="ISO date the page was retrieved")
    ap.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "data" / "db2_subjects.json"),
        help="output JSON path (default: backend/data/db2_subjects.json)",
    )
    args = ap.parse_args(argv)

    html_text = Path(args.html).read_text(encoding="utf-8")
    doc = build_subjects_doc(
        html_text, source_url=args.source_url, retrieved_at=args.retrieved_at
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(doc['subjects'])} subjects → {out_path}")


if __name__ == "__main__":
    main()
