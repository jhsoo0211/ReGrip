"""의존성 격리 가드: src.main 임포트가 numpy/scipy 를 끌어오지 않음을 보장.

**반드시 subprocess** 로 깨끗한 인터프리터에서 검사한다. in-process 검사는 같은 세션의 다른
테스트(test_ingest_db2 등)가 이미 scipy 를 import 해 sys.modules 를 오염시키므로 신뢰할 수 없다.

운영 API 이미지에 numpy/scipy 가 새면 컨테이너가 3-5× 커진다 → src/ 는 신호작업에 stdlib 만.
numpy/scipy 는 오직 scripts/sig/·tests 에서만.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]

_PROBE = (
    "import sys\n"
    "import src.main  # noqa\n"
    "leaked = sorted(m for m in sys.modules "
    "if m == 'numpy' or m.startswith('numpy.') "
    "or m == 'scipy' or m.startswith('scipy.'))\n"
    "assert not leaked, 'numpy/scipy leaked into src.main: %r' % leaked\n"
    "print('NO_NUMPY_SCIPY_OK')\n"
)


def test_src_main_does_not_import_numpy_scipy():
    env = dict(os.environ)
    env["DATABASE_URL"] = "sqlite://"
    env["ENV"] = "test"
    env["JWT_SECRET"] = "test-secret-key"

    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(_BACKEND),
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "NO_NUMPY_SCIPY_OK" in result.stdout
