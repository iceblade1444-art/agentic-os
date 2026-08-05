from .config import Settings


class MCPAuthConfigError(RuntimeError):
    """Raised when the MCP server is missing ERP API authentication config."""


def auth_headers(settings: Settings) -> dict[str, str]:
    if settings.auth_mode == "bearer":
        token = settings.bearer_token_value
        if not token:
            if settings.login_username_value and settings.login_password_value:
                raise MCPAuthConfigError("ERP login credentials must be resolved by ERPApiClient")
            raise MCPAuthConfigError("ERP_MCP_BEARER_TOKEN or ERP_MCP_USERNAME/ERP_MCP_PASSWORD is required when ERP_MCP_AUTH_MODE=bearer")
        return {"Authorization": f"Bearer {token}"}
    raise MCPAuthConfigError(f"Unsupported ERP_MCP_AUTH_MODE={settings.auth_mode}")
