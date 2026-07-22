"""ORM 모델 집합. Base.metadata 에 모든 테이블이 등록되도록 여기서 임포트한다."""
from __future__ import annotations

from .auth import RefreshToken
from .base import Base
from .device import Calibration, Device
from .gamification import (
    AchievementDefinition,
    UserAchievement,
    UserStats,
    XpEvent,
)
from .session import Session, SessionSet
from .user import Profile, User, UserSettings

__all__ = [
    "Base",
    "User",
    "Profile",
    "UserSettings",
    "Device",
    "Calibration",
    "Session",
    "SessionSet",
    "AchievementDefinition",
    "UserAchievement",
    "XpEvent",
    "UserStats",
    "RefreshToken",
]

# 신호 카탈로그(sig_*)는 선택적 서브시스템이다.
# 공개 NinaPro 데이터셋을 다루는 ML용 서브시스템으로, 실데이터/실기기 없이는 비활성 상태다.
# signal.py 등 sig 소스 파일이 없으면 여기서 조용히 건너뛰고, 백엔드는 sig_* 테이블 없이 정상 동작한다.
# import 가 성공할 때만 Sig 모델들이 Base.metadata 에 등록되어 create_all 이 sig_* 테이블을 만든다.
try:
    from .signal import (
        SigChannel,
        SigDataset,
        SigLabel,
        SigRecording,
        SigSegment,
        SigSignalBlob,
        SigSubject,
    )
except ImportError:
    pass
else:
    # 없는 이름을 __all__ 에 남기면 `from src.models import *` 가 AttributeError 를 내므로,
    # import 성공 시에만 Sig 이름을 등재한다.
    __all__ += [
        "SigDataset",
        "SigSubject",
        "SigRecording",
        "SigSignalBlob",
        "SigChannel",
        "SigLabel",
        "SigSegment",
    ]
