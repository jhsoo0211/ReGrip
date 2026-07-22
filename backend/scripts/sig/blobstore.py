"""content-addressed .npy blob 저장 (numpy 사용).

벌크 신호는 DB 밖 파일로 둔다. 경로는 파일 바이트의 sha256 로 결정(content-addressed)하므로
사람이 경로를 짓지 않는다. 같은 내용이면 같은 경로 → 자연 dedup. 원자적 write(temp 후 os.replace)
로 부분 파일이 남지 않게 한다("blob 먼저" 원칙: 파일을 먼저 flush 하고 DB 행은 나중에).
"""
from __future__ import annotations

import hashlib
import io
import os
import tempfile
from pathlib import Path

import numpy as np


def blob_rel_path(sha_hex: str) -> str:
    """sha256 hex → 저장소 상대경로. 앞 2/2 바이트로 팬아웃한 디렉터리 트리."""
    return f"blobs/sha256/{sha_hex[:2]}/{sha_hex[2:4]}/{sha_hex}.npy"


def write_blob(root, arr) -> tuple[str, bytes, int]:
    """arr 을 float32 C-order .npy 로 직렬화해 content-addressed 경로에 저장.

    반환: (rel_path, sha256_bytes, n_bytes).
    - sha256 은 **.npy 파일 바이트 전체** 기준(결정론). arr 자체가 아니라 직렬화 결과 기준이라
      dtype/shape/헤더까지 내용에 포함된다.
    - 이미 존재하면 재기록하지 않는다(dedup). 없으면 temp 파일에 쓰고 os.replace 로 원자 이동.
    """
    root = Path(root)
    arr = np.ascontiguousarray(arr, dtype=np.float32)

    buf = io.BytesIO()
    np.save(buf, arr, allow_pickle=False)
    data = buf.getvalue()

    sha = hashlib.sha256(data).digest()
    rel = blob_rel_path(sha.hex())
    dest = root / rel

    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(dest.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, dest)  # 원자적: 성공 시에만 최종 경로가 나타난다
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    return rel, sha, len(data)
