from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from milana_erp_mcp.client import ERPApiClient
from milana_erp_mcp.config import Settings
from milana_erp_mcp.tools import (
    erp_active_production_tool,
    erp_business_control_tool,
    erp_create_task_tool,
    erp_finance_summary_tool,
    erp_finished_goods_stock_tool,
    erp_gm_summary_tool,
    erp_me_tool,
    erp_search_tool,
    erp_send_notification_tool,
)


ME = {
    "id": 7,
    "name": "General Manager",
    "email": "gm@example.com",
    "role": "Management",
    "department": "Management",
    "permissions": ["management.view", "finance.view"],
}


def _json_response(status_code: int, payload: Any) -> httpx.Response:
    return httpx.Response(status_code, json=payload, headers={"content-type": "application/json"})


def _settings() -> Settings:
    return Settings(erp_api_base_url="http://erp.test", bearer_token="real-user-token")


def _login_settings() -> Settings:
    return Settings(erp_api_base_url="http://erp.test", bearer_token="", username="agentic-os", password="service-password")


async def _with_client(
    handler: Callable[[httpx.Request, list[httpx.Request]], httpx.Response],
    callback: Callable[[ERPApiClient, list[httpx.Request], Settings], Any],
) -> Any:
    seen: list[httpx.Request] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.headers["authorization"] == "Bearer real-user-token"
        return handler(request, seen)

    settings = _settings()
    async with httpx.AsyncClient(base_url=settings.erp_api_base_url, transport=httpx.MockTransport(transport_handler)) as raw:
        client = ERPApiClient(settings=settings, http_client=raw)
        return await callback(client, seen, settings)


@pytest.mark.asyncio
async def test_erp_me_returns_authenticated_user() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        assert request.url.path == "/api/auth/me"
        return _json_response(200, ME)

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_me_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["data"]["id"] == 7


@pytest.mark.asyncio
async def test_erp_client_can_login_for_short_lived_bearer_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            assert request.method == "POST"
            return httpx.Response(200, json={"message": "logged_in"}, headers={"set-cookie": "erp_access_token=fresh-token; Path=/"})
        assert request.url.path == "/api/auth/me"
        assert request.headers["authorization"] == "Bearer fresh-token"
        return _json_response(200, ME)

    settings = _login_settings()
    async with httpx.AsyncClient(base_url=settings.erp_api_base_url, transport=httpx.MockTransport(handler)) as raw:
        client = ERPApiClient(settings=settings, http_client=raw)
        result = await erp_me_tool(settings=settings, client=client)

    assert result["ok"] is True
    assert [request.url.path for request in seen] == ["/api/auth/login", "/api/auth/me"]


@pytest.mark.asyncio
async def test_erp_search_wraps_global_search_and_sanitizes_fields() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/search"
        assert request.url.params["q"] == "SO-100"
        return _json_response(
            200,
            [
                {
                    "type": "SalesOrder",
                    "id": 10,
                    "label": "SO-100",
                    "url": "/sales-orders/10",
                    "password_hash": "must-not-leak",
                    "api_token": "must-not-leak",
                }
            ],
        )

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_search_tool("SO-100", settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["data"][0]["label"] == "SO-100"
    assert "password_hash" not in result["data"][0]
    assert "api_token" not in result["data"][0]


@pytest.mark.asyncio
async def test_erp_gm_summary_wraps_management_dashboard() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/dashboard/management"
        return _json_response(200, {"active_orders": 12, "late_orders": 2})

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_gm_summary_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["data"]["active_orders"] == 12


@pytest.mark.asyncio
async def test_erp_active_production_reads_production_kpis() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/dashboard/production"
        return _json_response(200, {"cutting_output": 7592, "sewing_output": 535, "packaging_output": 535})

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_active_production_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["source"] == "/api/dashboard/production"
    assert result["data"]["cutting_output"] == 7592


@pytest.mark.asyncio
async def test_erp_finished_goods_stock_reads_ready_product_warehouse() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/packages/storage-map"
        return _json_response(
            200,
            {
                "summary": {"packages_on_map": 9, "packages_in_storage": 9, "cells_occupied": 1},
                "placements": [
                    {
                        "package_no": "PKG-1",
                        "model_code": "РJ1118-2922",
                        "model_name": "Фут-штаны",
                        "order_no": "SO-2026-000017",
                        "color": "white",
                        "total_quantity": 300,
                        "storage_cell": "N-01",
                        "storage_shelf": "S1",
                        "status": "received_in_storage",
                    },
                    {
                        "package_no": "PKG-2",
                        "model_code": "РJ1118-2922",
                        "model_name": "Фут-штаны",
                        "order_no": "SO-2026-000017",
                        "color": "white",
                        "total_quantity": 235,
                        "storage_cell": "N-01",
                        "storage_shelf": "S1",
                        "status": "received_in_storage",
                    },
                ],
            },
        )

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_finished_goods_stock_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["source"] == "/api/packages/storage-map"
    assert result["source_page"] == "/warehouse-stock"
    assert result["map_page"] == "/warehouse-map"
    assert result["data"]["total_pieces"] == 535
    assert result["data"]["total_packages"] == 2
    assert result["data"]["top_models"][0]["model_code"] == "РJ1118-2922"
    assert result["data"]["top_models"][0]["model_name"] == "Фут-штаны"
    assert result["data"]["top_models"][0]["sample_rows"][0]["cell"] == "N-01"


@pytest.mark.asyncio
async def test_erp_finished_goods_stock_falls_back_to_ready_product_rows() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        if request.url.path == "/api/packages/storage-map":
            return _json_response(200, {"placements": []})
        assert request.url.path == "/api/finished-goods"
        return _json_response(
            200,
            [
                {
                    "model_code": "РJ1118-2922",
                    "model_name": "Фут-штаны",
                    "order_no": "SO-2026-000017",
                    "color": "white",
                    "size": "50",
                    "quantity": 300,
                    "available_quantity": 300,
                    "reserved_quantity": 0,
                    "package_id": "PKG-1",
                    "section": "N",
                    "cell": "N-01",
                    "shelf": "S1",
                    "status": "available",
                },
            ],
        )

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_finished_goods_stock_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["source"] == "/api/packages/storage-map"
    assert result["data"]["total_pieces"] == 300
    assert result["data"]["total_packages"] == 1
    assert result["data"]["top_models"][0]["model_code"] == "РJ1118-2922"
    assert result["data"]["top_models"][0]["model_name"] == "Фут-штаны"
    assert result["data"]["top_models"][0]["sample_rows"][0]["cell"] == "N-01"


@pytest.mark.asyncio
async def test_erp_business_control_builds_process_snapshot() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/process-tracking"
        return _json_response(
            200,
            [
                {
                    "production_order_id": 1,
                    "production_no": "PO-1",
                    "order_no": "SO-1",
                    "model_code": "M-1",
                    "model_name": "Model 1",
                    "planned_quantity": 600,
                    "actual_quantity": 100,
                    "current_stage": "sewing",
                    "current_stage_status": "in_progress",
                    "sewing_factories": [{"name": "Line A"}],
                    "stages": [
                        {"operation": "sewing", "sewing_flow_name": "Line A", "deadline": "2026-08-08T10:00:00+00:00"},
                        {"operation": "storage_transfer", "status": "waiting", "deadline": "2026-08-10T10:00:00+00:00"},
                    ],
                },
                {
                    "production_order_id": 2,
                    "production_no": "PO-2",
                    "order_no": "SO-2",
                    "model_code": "M-2",
                    "model_name": "Model 2",
                    "planned_quantity": 400,
                    "actual_quantity": 0,
                    "current_stage": "sewing",
                    "current_stage_status": "waiting",
                    "sewing_factories": [{"name": "Line A"}],
                    "stages": [
                        {"operation": "sewing", "sewing_flow_name": "Line A"},
                        {"operation": "storage_transfer", "status": "waiting", "deadline": "2026-08-11T10:00:00+00:00"},
                    ],
                },
                {
                    "production_order_id": 3,
                    "production_no": "PO-3",
                    "order_no": "SO-3",
                    "model_code": "M-3",
                    "model_name": "Model 3",
                    "planned_quantity": 300,
                    "actual_quantity": 0,
                    "current_stage": "cutting",
                    "current_stage_status": "waiting",
                    "po_overdue": True,
                    "po_deadline": "2026-08-07T10:00:00+00:00",
                    "stages": [
                        {"operation": "cutting", "status": "waiting", "deadline": "2026-08-07T10:00:00+00:00", "overdue": True},
                    ],
                },
            ],
        )

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_business_control_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["source"] == "/api/process-tracking"
    assert result["data"]["total_orders"] == 3
    assert result["data"]["cutting_department"]["orders"] == 1
    assert result["data"]["cutting_department"]["planned_quantity"] == 300
    assert result["data"]["answer_hints"]["cutting_department"]["top_orders"][0]["production_no"] == "PO-3"
    assert result["data"]["answer_hints"]["busiest_sewing_flow"]["flow"] == "Line A"
    assert result["data"]["answer_hints"]["busiest_sewing_flow"]["planned_quantity"] == 1000
    assert result["data"]["answer_hints"]["next_warehouse_order"]["production_no"] == "PO-1"


@pytest.mark.asyncio
async def test_send_notification_preview_does_not_call_send_endpoint() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        assert request.url.path == "/api/auth/me"
        return _json_response(200, ME)

    async def callback(client: ERPApiClient, seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        result = await erp_send_notification_tool(
            target_type="user_id",
            user_id=3,
            title="Check late order",
            message="Please review SO-100.",
            settings=settings,
            client=client,
        )
        assert [request.url.path for request in seen] == ["/api/auth/me"]
        return result

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["requires_confirmation"] is True
    assert result["preview"]["target"]["user_id"] == 3


@pytest.mark.asyncio
async def test_send_notification_confirm_calls_backend_endpoint() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.method == "POST"
        assert request.url.path == "/api/notifications/send"
        payload = json.loads(request.content)
        assert payload["target_type"] == "department"
        assert payload["department"] == "cutting"
        return _json_response(
            200,
            {
                "message": "notification_sent",
                "created_count": 2,
                "notification_ids": [91, 92],
                "recipients": [{"user_id": 11}, {"user_id": 12}],
            },
        )

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_send_notification_tool(
            target_type="department",
            department="cutting",
            title="Production update",
            message="Please review the active queue.",
            confirm=True,
            settings=settings,
            client=client,
        )

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["data"]["created_count"] == 2


@pytest.mark.asyncio
async def test_create_task_preview_does_not_create_task() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        assert request.url.path == "/api/auth/me"
        return _json_response(200, ME)

    async def callback(client: ERPApiClient, seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        result = await erp_create_task_tool(
            assignee_user_id=3,
            title="Review delayed bundles",
            description="Check bundle queue.",
            settings=settings,
            client=client,
        )
        assert [request.url.path for request in seen] == ["/api/auth/me"]
        return result

    result = await _with_client(handler, callback)
    assert result["ok"] is True
    assert result["requires_confirmation"] is True
    assert result["preview"]["assignee"]["user_id"] == 3


@pytest.mark.asyncio
async def test_api_permission_error_is_clean() -> None:
    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json_response(200, ME)
        assert request.url.path == "/api/dashboard/finance"
        return _json_response(403, {"detail": "Missing permission"})

    async def callback(client: ERPApiClient, _seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        return await erp_finance_summary_tool(settings=settings, client=client)

    result = await _with_client(handler, callback)
    assert result["ok"] is False
    assert result["error"]["status_code"] == 403
    assert result["error"]["message"] == "ERP permission denied for this tool."


@pytest.mark.asyncio
async def test_non_gm_user_is_blocked_by_mcp_gate() -> None:
    non_gm = {
        "id": 22,
        "name": "Operator",
        "email": "operator@example.com",
        "role": "Cutting",
        "department": "Cutting",
        "permissions": ["cutting.records"],
    }

    def handler(request: httpx.Request, _seen: list[httpx.Request]) -> httpx.Response:
        assert request.url.path == "/api/auth/me"
        return _json_response(200, non_gm)

    async def callback(client: ERPApiClient, seen: list[httpx.Request], settings: Settings) -> dict[str, Any]:
        result = await erp_search_tool("SO-100", settings=settings, client=client)
        assert [request.url.path for request in seen] == ["/api/auth/me"]
        return result

    result = await _with_client(handler, callback)
    assert result["ok"] is False
    assert result["error"]["status_code"] == 403
    assert "GM-only" in result["error"]["message"]
