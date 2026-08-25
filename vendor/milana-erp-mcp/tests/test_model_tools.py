"""The model catalogue tools, and the three ways the ERP could make them lie.

Every one of these mirrors something established against the live endpoint,
not something assumed:

  * /api/models pages at 100 and reports no total, so the walk has to stop on a
    short page and say when it ran out of budget instead.
  * `search`, `q`, `name` and `season` are accepted and silently ignored. A tool
    that forwarded them would return the unfiltered first page and present it
    as a search result, which is worse than an error.
  * `material_composition` is empty on live records while the composition sits
    in `details_json.composition`.
"""

from __future__ import annotations

from typing import Any, Callable

import httpx
import pytest

from milana_erp_mcp.client import ERPApiClient
from milana_erp_mcp.config import Settings
from milana_erp_mcp.tools import (
    MODELS_PAGE_SIZE,
    erp_model_details_tool,
    erp_model_search_tool,
    erp_models_overview_tool,
)

ME = {
    "id": 7,
    "name": "General Manager",
    "role": "Management",
    "department": "Management",
    "permissions": ["management.view"],
}


def _json(status_code: int, payload: Any) -> httpx.Response:
    return httpx.Response(status_code, json=payload, headers={"content-type": "application/json"})


def _settings() -> Settings:
    return Settings(erp_api_base_url="http://erp.test", bearer_token="real-user-token")


def _model(idx: int, **over: Any) -> dict[str, Any]:
    row = {
        "id": 7000 + idx,
        "code": f"TJ{2000 + idx}",
        "name": "Туника",
        "status": "approved",
        "thumbnail_url": f"/storage/model-files/model_{idx}.webp",
        "created_at": f"2026-08-{(idx % 28) + 1:02d}T05:39:12Z",
    }
    row.update(over)
    return row


async def _run(handler: Callable[[httpx.Request], httpx.Response], call) -> dict[str, Any]:
    settings = _settings()
    async with httpx.AsyncClient(
        base_url=settings.erp_api_base_url, transport=httpx.MockTransport(handler)
    ) as raw:
        client = ERPApiClient(settings=settings, http_client=raw)
        return await call(client, settings)


def _catalogue(total: int) -> Callable[[httpx.Request], httpx.Response]:
    """A catalogue of `total` models, paged the way the real one pages."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        assert request.url.path == "/api/models", request.url.path
        page = int(request.url.params.get("page", 1))
        size = int(request.url.params.get("page_size", MODELS_PAGE_SIZE))
        start = (page - 1) * size
        rows = [_model(i) for i in range(start, min(start + size, total))]
        return _json(200, rows)

    return handler


@pytest.mark.asyncio
async def test_overview_counts_past_the_first_page() -> None:
    # The endpoint hands back 100 at a time. A tool that read one page would
    # report 100 models for a catalogue of 6,600 and sound completely sure.
    result = await _run(
        _catalogue(250),
        lambda client, settings: erp_models_overview_tool(settings=settings, client=client),
    )
    assert result["ok"] is True
    assert result["data"]["total_models"] == 250
    assert result["data"]["counted_completely"] is True


@pytest.mark.asyncio
async def test_overview_admits_when_it_ran_out_of_budget() -> None:
    # A catalogue that outgrows the page budget must produce a floor that says
    # it is a floor, never a total presented as fact.
    from milana_erp_mcp import tools as tools_module

    original = tools_module.MODELS_PAGE_BUDGET
    tools_module.MODELS_PAGE_BUDGET = 2
    try:
        result = await _run(
            _catalogue(1000),
            lambda client, settings: erp_models_overview_tool(settings=settings, client=client),
        )
    finally:
        tools_module.MODELS_PAGE_BUDGET = original
    assert result["data"]["total_models"] == 200
    assert result["data"]["counted_completely"] is False


@pytest.mark.asyncio
async def test_overview_groups_by_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        page = int(request.url.params.get("page", 1))
        if page > 1:
            return _json(200, [])
        return _json(200, [
            _model(1, status="approved"),
            _model(2, status="approved"),
            _model(3, status="draft", thumbnail_url=None),
        ])

    result = await _run(
        handler,
        lambda client, settings: erp_models_overview_tool(settings=settings, client=client),
    )
    assert result["data"]["by_status"] == {"approved": 2, "draft": 1}
    assert result["data"]["with_image"] == 2


@pytest.mark.asyncio
async def test_search_never_forwards_a_parameter_the_erp_ignores() -> None:
    # This is the whole reason matching happens locally. If `search` were sent,
    # the ERP would answer with the unfiltered first page and the tool would
    # report every model as a match.
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        seen.append(request)
        page = int(request.url.params.get("page", 1))
        if page > 1:
            return _json(200, [])
        return _json(200, [
            _model(1, name="Туника"),
            _model(2, name="Халат"),
            _model(3, name="Спортивка"),
        ])

    result = await _run(
        handler,
        lambda client, settings: erp_model_search_tool(
            query="туник", settings=settings, client=client
        ),
    )
    for request in seen:
        params = request.url.params
        for ignored in ("search", "q", "name", "season", "product_type"):
            assert ignored not in params, f"{ignored} was sent and the ERP ignores it"
    assert result["data"]["total_matches"] == 1
    assert result["data"]["models"][0]["name"] == "Туника"


@pytest.mark.asyncio
async def test_search_matches_code_as_well_as_name() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        page = int(request.url.params.get("page", 1))
        if page > 1:
            return _json(200, [])
        return _json(200, [_model(1, code="TJ2211"), _model(2, code="XX9999", name="Халат")])

    result = await _run(
        handler,
        lambda client, settings: erp_model_search_tool(
            query="tj2211", settings=settings, client=client
        ),
    )
    # Case-insensitive, because nobody types a model code the way it is stored.
    assert result["data"]["total_matches"] == 1
    assert result["data"]["models"][0]["code"] == "TJ2211"


@pytest.mark.asyncio
async def test_search_says_when_it_is_showing_only_some_of_the_matches() -> None:
    result = await _run(
        _catalogue(80),
        lambda client, settings: erp_model_search_tool(
            query="туник", limit=10, settings=settings, client=client
        ),
    )
    assert result["data"]["total_matches"] == 80
    assert result["data"]["returned"] == 10
    assert result["data"]["showing_all_matches"] is False


@pytest.mark.asyncio
async def test_search_passes_status_through_because_that_one_is_real() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        seen.append(request)
        return _json(200, [_model(1, status="draft")])

    await _run(
        handler,
        lambda client, settings: erp_model_search_tool(
            status="draft", settings=settings, client=client
        ),
    )
    assert seen and seen[0].url.params["status"] == "draft"


@pytest.mark.asyncio
async def test_details_reads_composition_from_where_it_actually_lives() -> None:
    # material_composition is empty on every live record; the composition is in
    # details_json. Reading the obvious field says "no composition" for a
    # garment that is 100% cotton.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        assert request.url.path == "/api/models/7201"
        return _json(200, {
            "id": 7201,
            "code": "TJ2211",
            "name": "Туника",
            "status": "approved",
            "material_composition": [],
            "details_json": {
                "composition": [{"name": "Cotton", "percentage": 100}],
                "translation": {"ru": "Туника"},
            },
            "sizes": [],
            "colors": [],
            "bom": [],
            "images": [{"id": 1}],
        })

    result = await _run(
        handler,
        lambda client, settings: erp_model_details_tool(
            model_id=7201, settings=settings, client=client
        ),
    )
    assert result["data"]["composition"] == [{"name": "Cotton", "percentage": 100}]
    assert result["data"]["translations"] == {"ru": "Туника"}
    assert result["data"]["image_count"] == 1


@pytest.mark.asyncio
async def test_details_leaves_the_money_out_of_the_materials() -> None:
    # The raw BOM carries default_cost and supplier SKUs on every line. What
    # comes back is which fabric and how much; cost is finance's to answer.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        return _json(200, {
            "id": 7201,
            "code": "TJ2211",
            "name": "Туника",
            "bom": [{
                "id": 263,
                "material_name": None,
                "quantity_per_piece": 0.35,
                "unit": "kg",
                "waste_percent": 5,
                "item": {
                    "id": 81,
                    "sku": "MAT-30-1-COMPACT",
                    "name": "30/1 COMPACT PENYE SUPREM",
                    "category": "fabric",
                    "unit": "kg",
                    "default_cost": 42000,
                },
            }],
        })

    result = await _run(
        handler,
        lambda client, settings: erp_model_details_tool(
            model_id=7201, settings=settings, client=client
        ),
    )
    material = result["data"]["materials"][0]
    assert material["material"] == "30/1 COMPACT PENYE SUPREM"
    assert material["quantity_per_piece"] == 0.35
    serialised = repr(result)
    assert "default_cost" not in serialised
    assert "42000" not in serialised
    assert "MAT-30-1-COMPACT" not in serialised, "supplier SKUs are not part of the answer"


@pytest.mark.asyncio
async def test_details_resolves_a_code_with_one_request() -> None:
    # `code` is one of the two filters the ERP honours, so looking a model up by
    # code must not walk the catalogue.
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        seen.append(str(request.url))
        if request.url.path == "/api/models":
            assert request.url.params["code"] == "TJ2211"
            return _json(200, [_model(1, id=7201, code="TJ2211")])
        assert request.url.path == "/api/models/7201"
        return _json(200, {"id": 7201, "code": "TJ2211", "name": "Туника"})

    result = await _run(
        handler,
        lambda client, settings: erp_model_details_tool(
            code="TJ2211", settings=settings, client=client
        ),
    )
    assert result["ok"] is True
    assert result["data"]["code"] == "TJ2211"
    assert len([url for url in seen if "page=" in url]) == 0, "it walked the catalogue"


@pytest.mark.asyncio
async def test_details_refuses_a_near_miss_rather_than_guessing() -> None:
    # The code filter is not necessarily exact on the ERP side. Answering about
    # a neighbouring model because it came back first would be the worst
    # possible outcome of asking about a specific one.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            return _json(200, ME)
        return _json(200, [_model(1, code="TJ2211-V-5873")])

    result = await _run(
        handler,
        lambda client, settings: erp_model_details_tool(
            code="TJ2211", settings=settings, client=client
        ),
    )
    assert result["ok"] is False
    assert result["error"]["status_code"] == 404


@pytest.mark.asyncio
async def test_details_needs_to_be_told_which_model() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _json(200, ME)

    result = await _run(
        handler,
        lambda client, settings: erp_model_details_tool(settings=settings, client=client),
    )
    assert result["ok"] is False
    assert result["error"]["status_code"] == 400
