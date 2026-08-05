from __future__ import annotations

from http.cookies import SimpleCookie
from typing import Any

import httpx

from .audit import sanitize_payload
from .auth import MCPAuthConfigError, auth_headers
from .config import Settings, get_settings


class ERPApiError(RuntimeError):
    def __init__(self, status_code: int, detail: str, *, path: str | None = None):
        self.status_code = status_code
        self.detail = detail
        self.path = path
        super().__init__(detail)

    def to_public_dict(self) -> dict[str, Any]:
        if self.status_code == 401:
            message = "ERP authentication failed. Sign in again and provide a fresh ERP bearer token."
        elif self.status_code == 403:
            message = "ERP permission denied for this tool."
        else:
            message = self.detail
        return {
            "status_code": self.status_code,
            "message": message,
            "path": self.path,
        }


class ERPApiClient:
    def __init__(self, settings: Settings | None = None, http_client: httpx.AsyncClient | None = None):
        self.settings = settings or get_settings()
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            base_url=self.settings.erp_api_base_url,
            timeout=self.settings.http_timeout_seconds,
            follow_redirects=False,
        )
        self._session_token: str | None = None

    async def __aenter__(self) -> "ERPApiClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        api_path = path if path.startswith("/") else f"/{path}"
        try:
            headers = {
                "Accept": "application/json",
                "User-Agent": "milana-erp-mcp/0.1",
                **(await self._auth_headers()),
            }
            response = await self._client.request(method, api_path, params=params, json=json_body, headers=headers)
        except MCPAuthConfigError as exc:
            raise ERPApiError(401, str(exc), path=api_path) from exc
        except httpx.TimeoutException as exc:
            raise ERPApiError(504, "ERP API request timed out", path=api_path) from exc
        except httpx.RequestError as exc:
            raise ERPApiError(502, "ERP API request failed", path=api_path) from exc

        if response.status_code >= 400:
            raise ERPApiError(response.status_code, _error_detail(response), path=api_path)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            return sanitize_payload(response.json())
        except ValueError as exc:
            raise ERPApiError(502, "ERP API returned a non-JSON response", path=api_path) from exc

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, *, json_body: dict[str, Any] | None = None) -> Any:
        return await self.request("POST", path, json_body=json_body)

    async def get_me(self) -> dict[str, Any]:
        data = await self.get("/api/auth/me")
        return data if isinstance(data, dict) else {"raw": data}

    async def _auth_headers(self) -> dict[str, str]:
        if self.settings.bearer_token_value:
            return auth_headers(self.settings)
        username = self.settings.login_username_value
        password = self.settings.login_password_value
        if not username or not password:
            return auth_headers(self.settings)
        if not self._session_token:
            await self._login(username, password)
        return {"Authorization": f"Bearer {self._session_token}"}

    async def _login(self, username: str, password: str) -> None:
        try:
            response = await self._client.post(
                "/api/auth/login",
                data={"username": username, "password": password},
                headers={"Accept": "application/json", "User-Agent": "milana-erp-mcp/0.1"},
            )
        except httpx.TimeoutException as exc:
            raise ERPApiError(504, "ERP login timed out", path="/api/auth/login") from exc
        except httpx.RequestError as exc:
            raise ERPApiError(502, "ERP login request failed", path="/api/auth/login") from exc
        if response.status_code >= 400:
            raise ERPApiError(response.status_code, _error_detail(response), path="/api/auth/login")
        token = response.cookies.get("erp_access_token") or _cookie_value(response, "erp_access_token")
        if not token:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            token = payload.get("access_token") if isinstance(payload, dict) else None
        if not token:
            raise ERPApiError(401, "ERP login did not return an access token", path="/api/auth/login")
        self._session_token = str(token)


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return (response.text or f"ERP API error {response.status_code}")[:500]
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload.get("message") or payload
    else:
        detail = payload
    return str(detail)[:500]


def _cookie_value(response: httpx.Response, name: str) -> str | None:
    raw_cookie = response.headers.get("set-cookie")
    if not raw_cookie:
        return None
    parsed = SimpleCookie()
    parsed.load(raw_cookie)
    value = parsed.get(name)
    return value.value if value else None
