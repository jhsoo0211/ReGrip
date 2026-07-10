"""에러 규약 (02-api-spec §1.3).

모든 에러는 {"error": {"code","message","details"}} envelope 으로 나간다.
- AppError: 도메인/애플리케이션 에러(422 검증, 401, 403, 404, 409 ...).
- FastAPI RequestValidationError(스키마 검증) 는 VALIDATION_FAILED(422) envelope 으로 변환.
- HTTPException / 그 외 예외도 envelope 으로 감싼다.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    """envelope 로 변환되는 애플리케이션 에러."""

    def __init__(self, status_code: int, code: str, message: str, details: dict | None = None):
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


def _envelope(code: str, message: str, details: dict | None = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details or {}}}


# HTTP 상태 → 기본 code 매핑 (02 §1.3 카탈로그)
_STATUS_CODE = {
    400: "BAD_REQUEST",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_FAILED",
    429: "RATE_LIMITED",
}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):  # noqa: ANN001
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):  # noqa: ANN001
        errors = exc.errors()
        first = errors[0] if errors else {}
        loc = first.get("loc", [])
        field = loc[-1] if loc else None
        msg = first.get("msg", "요청 검증에 실패했습니다.")
        return JSONResponse(
            status_code=422,
            content=_envelope(
                "VALIDATION_FAILED",
                msg,
                {"field": field, "errors": _safe_errors(errors)},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):  # noqa: ANN001
        code = _STATUS_CODE.get(exc.status_code, "ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "요청을 처리할 수 없습니다."
        return JSONResponse(status_code=exc.status_code, content=_envelope(code, message))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # noqa: ANN001
        return JSONResponse(
            status_code=500,
            content=_envelope("INTERNAL_ERROR", "서버 내부 오류가 발생했습니다."),
        )


def _safe_errors(errors: list[dict]) -> list[dict]:
    """RequestValidationError.errors() 를 JSON 직렬화 가능한 형태로 정리."""
    out = []
    for e in errors:
        out.append(
            {
                "loc": [str(x) for x in e.get("loc", [])],
                "msg": e.get("msg"),
                "type": e.get("type"),
            }
        )
    return out
