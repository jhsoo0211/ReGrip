"""scrape_db2_subjects 파서를 작은 합성 HTML 로 검증 (실데이터 없음, stdlib html.parser).

파서가 subject 표를 정확히 뽑고, 값 타입/성별 정규화, provenance(page_sha256 결정론,
meta_confidence='inferred')를 만드는지 확인한다.
"""
from __future__ import annotations

from scripts.scrape_db2_subjects import build_subjects_doc, parse_subjects_html

_HTML = """
<html><body>
<h1>NinaPro DB2</h1>
<table>
  <tr><th>Subject</th><th>Gender</th><th>Age</th><th>Height</th><th>Weight</th><th>Handedness</th></tr>
  <tr><td>1</td><td>M</td><td>31</td><td>180</td><td>75</td><td>Right</td></tr>
  <tr><td>2</td><td>Female</td><td>29</td><td>165</td><td>60</td><td>Left</td></tr>
</table>
</body></html>
"""


def test_parse_subjects_html():
    rows = parse_subjects_html(_HTML)
    assert len(rows) == 2
    assert rows[0] == {
        "source_subject_id": 1,
        "sex": "male",
        "age_years": 31,
        "height_cm": 180,
        "weight_kg": 75,
        "handedness": "Right",
    }
    assert rows[1]["source_subject_id"] == 2
    assert rows[1]["sex"] == "female"
    assert rows[1]["handedness"] == "Left"


def test_build_doc_provenance_deterministic():
    doc = build_subjects_doc(
        _HTML, source_url="https://example/DB2.html", retrieved_at="2026-07-21"
    )
    assert doc["source_db"] == "DB2"
    assert len(doc["subjects"]) == 2
    prov = doc["provenance"]
    assert prov["source_url"] == "https://example/DB2.html"
    assert prov["retrieved_at"] == "2026-07-21"
    assert prov["meta_confidence"] == "inferred"
    # page_sha256 은 원본 HTML 바이트 기준(결정론) → 재계산 일치
    doc2 = build_subjects_doc(
        _HTML, source_url="https://example/DB2.html", retrieved_at="2026-07-21"
    )
    assert prov["page_sha256"] == doc2["provenance"]["page_sha256"]
    assert len(prov["page_sha256"]) == 64


def test_no_subject_table_raises():
    import pytest

    with pytest.raises(ValueError):
        parse_subjects_html("<table><tr><th>Foo</th></tr><tr><td>1</td></tr></table>")
