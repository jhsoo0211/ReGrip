"""NinaPro 신호 인제스트 스크립트 패키지 (numpy/scipy 사용 허용 경계).

src/ 는 신호 작업에 stdlib 만 쓴다. numpy/scipy 는 오직 이 패키지(scripts/sig/)와 tests/ 에서만
쓴다. 운영 API 이미지에 무거운 수치 라이브러리가 새어들지 않게 하는 의존성 격리 경계다.
"""
