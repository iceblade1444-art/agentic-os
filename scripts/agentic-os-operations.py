#!/usr/bin/env python3
"""Host-side backups and health checks for Agentic OS (standard library only)."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime | None = None) -> str:
    return (value or now()).isoformat().replace("+00:00", "Z")


def parse_time(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_project_env(root: Path) -> None:
    """Load missing values from the deployment .env for direct host invocations."""
    env_file = root / ".env"
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


class Operations:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.state_dir = Path(os.environ.get("OPS_STATE_DIR", Path.home() / ".local/state/agentic-os")).resolve()
        self.state_file = self.state_dir / "operations.json"
        self.request_file = self.state_dir / "backup.request"
        self.restore_request_file = self.state_dir / "restore.request"
        self.backup_root = Path(os.environ.get("OPS_BACKUP_DIR", Path.home() / "backups/agentic-os")).resolve()
        self.retention_days = max(1, int(os.environ.get("OPS_BACKUP_RETENTION_DAYS", "14")))
        self.max_backups = max(2, int(os.environ.get("OPS_BACKUP_MAX_COUNT", "14")))
        bind = os.environ.get("BIND_ADDRESS", "127.0.0.1")
        if bind in {"0.0.0.0", "::"}:
            bind = "127.0.0.1"
        self.health_url = os.environ.get("OPS_HEALTH_URL", f"http://{bind}:{os.environ.get('HOST_PORT', '8787')}/api/health")
        self.public_health_url = os.environ.get("OPS_PUBLIC_HEALTH_URL", "").strip()
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)

    @contextlib.contextmanager
    def locked(self):
        lock_path = self.state_dir / "operations.lock"
        with lock_path.open("a", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield

    def load(self) -> dict:
        try:
            value = json.loads(self.state_file.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def save(self, state: dict) -> None:
        state["updatedAt"] = iso()
        fd, temp_name = tempfile.mkstemp(prefix="operations-", suffix=".json", dir=self.state_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle, indent=2, ensure_ascii=True)
                handle.write("\n")
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, self.state_file)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temp_name)

    def run(self, *args: str, timeout: int = 12) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=self.root, text=True, capture_output=True, timeout=timeout, check=False)

    def backup(self) -> dict:
        with self.locked():
            self.request_file.unlink(missing_ok=True)
            state = self.load()
            state["backup"] = {**state.get("backup", {}), "status": "running", "startedAt": iso(), "error": None}
            self.save(state)

            stamp = now().strftime("%Y%m%dT%H%M%SZ")
            destination = self.backup_root / stamp
            destination.mkdir(mode=0o700)
            try:
                env_file = self.root / ".env"
                if env_file.exists():
                    shutil.copy2(env_file, destination / ".env")
                    os.chmod(destination / ".env", 0o600)
                git = self.run("git", "rev-parse", "HEAD")
                (destination / "git-head").write_text((git.stdout.strip() or "unknown") + "\n", encoding="utf-8")

                archives = []
                for name in ("data", "vault", "agentos-runtime"):
                    source = self.root / name
                    if not source.exists():
                        continue
                    archive = destination / f"{name}.tgz"
                    with tarfile.open(archive, "w:gz", compresslevel=6) as bundle:
                        bundle.add(source, arcname=name, recursive=True, filter=self._tar_filter)
                    archives.append(archive.name)

                database_dumps = []
                postgres_dump = self.postgres_dump(destination)
                if postgres_dump:
                    database_dumps.append(postgres_dump.name)

                size = sum(item.stat().st_size for item in destination.rglob("*") if item.is_file())
                completed = iso()
                manifest = {
                    "version": 2,
                    "status": "success",
                    "createdAt": completed,
                    "gitHead": git.stdout.strip() or None,
                    "archives": archives,
                    "databaseDumps": database_dumps,
                    "sizeBytes": size,
                }
                (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                os.chmod(destination / "manifest.json", 0o600)
                removed = self.prune(destination)
                state = self.load()
                state["backup"] = {
                    "status": "success", "lastSuccessAt": completed, "path": str(destination),
                    "sizeBytes": size, "count": self.backup_count(), "retentionDays": self.retention_days,
                    "maxCount": self.max_backups, "removed": removed, "error": None,
                }
                self.save(state)
                return state["backup"]
            except Exception as error:
                state = self.load()
                state["backup"] = {**state.get("backup", {}), "status": "error", "failedAt": iso(), "error": str(error)[:500]}
                self.save(state)
                self.notify("critical", f"Agentic OS backup failed: {error}")
                raise

    def postgres_dump(self, destination: Path) -> Path | None:
        inspect = self.run("docker", "inspect", "--format", "{{.State.Running}}", "agentic-os-postgres")
        if inspect.returncode != 0 or inspect.stdout.strip() != "true":
            return None
        user = os.environ.get("POSTGRES_USER", "agentic_os")
        database = os.environ.get("POSTGRES_DB", "agentic_os")
        target = destination / "postgres.dump"
        with target.open("wb") as output:
            result = subprocess.run(
                ["docker", "exec", "agentic-os-postgres", "pg_dump", "-U", user, "-d", database, "--format=custom"],
                cwd=self.root,
                stdout=output,
                stderr=subprocess.PIPE,
                timeout=120,
                check=False,
            )
        if result.returncode != 0:
            target.unlink(missing_ok=True)
            raise RuntimeError(f"PostgreSQL backup failed: {result.stderr.decode('utf-8', 'replace')[:300]}")
        os.chmod(target, 0o600)
        return target

    @staticmethod
    def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = Path(info.name).parts
        if any(part in {"node_modules", ".git", "__pycache__"} for part in parts):
            return None
        return info

    def backup_count(self) -> int:
        return sum(1 for item in self.backup_root.iterdir() if item.is_dir() and item.name[:8].isdigit())

    def latest_backup(self) -> Path | None:
        entries = sorted((item for item in self.backup_root.iterdir() if item.is_dir() and item.name[:8].isdigit()), reverse=True)
        return entries[0] if entries else None

    @staticmethod
    def assert_safe_tar_member(member: tarfile.TarInfo) -> None:
        target = Path(member.name)
        if target.is_absolute() or ".." in target.parts:
            raise RuntimeError(f"unsafe archive path: {member.name}")

    def restore_drill(self, backup_path: Path | None = None) -> dict:
        with self.locked():
            self.restore_request_file.unlink(missing_ok=True)
            state = self.load()
            state["restoreDrill"] = {**state.get("restoreDrill", {}), "status": "running", "startedAt": iso(), "error": None}
            self.save(state)

            try:
                selected = backup_path or self.latest_backup()
                if not selected:
                    raise RuntimeError("no backup is available for restore drill")
                selected = selected.resolve()
                if not selected.is_dir() or self.backup_root not in selected.parents:
                    raise RuntimeError("restore drill can only read backups inside OPS_BACKUP_DIR")

                manifest_file = selected / "manifest.json"
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                archives = manifest.get("archives", [])
                if not isinstance(archives, list) or not archives:
                    raise RuntimeError("backup manifest does not list archives")
                git_head = (selected / "git-head").read_text(encoding="utf-8").strip()
                if not git_head:
                    raise RuntimeError("backup git-head is empty")

                checked_files = 0
                checked_archives = []
                with tempfile.TemporaryDirectory(prefix="agentic-os-restore-", dir=self.state_dir) as temp_dir:
                    target_root = Path(temp_dir).resolve()
                    for archive_name in archives:
                        archive = selected / str(archive_name)
                        if not archive.is_file():
                            raise RuntimeError(f"missing archive: {archive_name}")
                        with tarfile.open(archive, "r:gz") as bundle:
                            members = bundle.getmembers()
                            for member in members:
                                self.assert_safe_tar_member(member)
                            bundle.extractall(target_root)
                            checked_files += sum(1 for member in members if member.isfile())
                        checked_archives.append(str(archive_name))

                    checked_database_dumps = []
                    for dump_name in manifest.get("databaseDumps", []):
                        dump = selected / str(dump_name)
                        if not dump.is_file() or dump.stat().st_size == 0:
                            raise RuntimeError(f"missing PostgreSQL dump: {dump_name}")
                        result = subprocess.run(
                            ["docker", "exec", "-i", "agentic-os-postgres", "pg_restore", "--list"],
                            cwd=self.root,
                            input=dump.read_bytes(),
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            timeout=120,
                            check=False,
                        )
                        if result.returncode != 0:
                            raise RuntimeError(
                                f"invalid PostgreSQL dump: {result.stderr.decode('utf-8', 'replace')[:300]}"
                            )
                        checked_database_dumps.append(str(dump_name))

                    if not any(target_root.iterdir()):
                        raise RuntimeError("restore drill extracted no files")

                completed = iso()
                state = self.load()
                state["restoreDrill"] = {
                    "status": "success",
                    "lastSuccessAt": completed,
                    "backupPath": str(selected),
                    "gitHead": git_head,
                    "archives": checked_archives,
                    "databaseDumps": checked_database_dumps,
                    "filesChecked": checked_files,
                    "error": None,
                }
                self.save(state)
                return state["restoreDrill"]
            except Exception as error:
                state = self.load()
                state["restoreDrill"] = {**state.get("restoreDrill", {}), "status": "error", "failedAt": iso(), "error": str(error)[:500]}
                self.save(state)
                self.notify("critical", f"Agentic OS restore drill failed: {error}")
                raise

    def prune(self, current: Path) -> list[str]:
        entries = sorted((item for item in self.backup_root.iterdir() if item.is_dir() and item.name[:8].isdigit()), reverse=True)
        cutoff = now() - dt.timedelta(days=self.retention_days)
        removed = []
        for index, item in enumerate(entries):
            if item == current:
                continue
            modified = dt.datetime.fromtimestamp(item.stat().st_mtime, dt.timezone.utc)
            if index >= self.max_backups or modified < cutoff:
                shutil.rmtree(item)
                removed.append(item.name)
        return removed

    def check_http(self, url: str, check_id: str, label: str, include_providers: bool = False) -> dict:
        try:
            with urllib.request.urlopen(url, timeout=8) as response:
                payload = json.loads(response.read(256_000))
            if response.status != 200 or not payload.get("ok"):
                raise RuntimeError(f"HTTP {response.status}")
            providers = payload.get("providers", {})
            detail = "API ready"
            if include_providers and providers.get("hermes"):
                detail += ", Hermes provider ready"
            return self.check(check_id, label, "healthy", detail)
        except Exception as error:
            return self.check(check_id, label, "critical", str(error))

    def check_container(self, name: str, label: str) -> dict:
        result = self.run("docker", "inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", name)
        value = result.stdout.strip()
        if result.returncode != 0:
            return self.check(f"container-{name}", label, "critical", (result.stderr.strip() or "not found")[:240])
        parts = value.split()
        running = parts and parts[0] == "running"
        health = parts[1] if len(parts) > 1 else "none"
        status = "healthy" if running and health not in {"unhealthy", "starting"} else ("degraded" if running else "critical")
        return self.check(f"container-{name}", label, status, f"{parts[0] if parts else 'unknown'}, health {health}")

    def check_service(self, unit: str, label: str) -> dict:
        result = self.run("systemctl", "--user", "is-active", unit)
        value = result.stdout.strip() or "unknown"
        return self.check(f"service-{unit}", label, "healthy" if value == "active" else "degraded", value)

    def check_disk(self) -> dict:
        usage = shutil.disk_usage(self.root)
        percent = round((usage.used / usage.total) * 100, 1)
        status = "critical" if percent >= 90 else "degraded" if percent >= 80 else "healthy"
        return self.check("disk", "Server storage", status, f"{percent}% used", {"usedPercent": percent, "freeBytes": usage.free, "totalBytes": usage.total})

    def check_backup(self, state: dict) -> dict:
        backup = state.get("backup", {})
        last = parse_time(backup.get("lastSuccessAt"))
        if backup.get("status") == "error":
            return self.check("backup", "Automated backup", "critical", backup.get("error") or "last backup failed")
        if not last:
            return self.check("backup", "Automated backup", "degraded", "no successful backup recorded")
        age = now() - last
        status = "healthy" if age < dt.timedelta(hours=36) else "degraded"
        return self.check("backup", "Automated backup", status, f"last success {round(age.total_seconds() / 3600, 1)}h ago")

    def check_restore_drill(self, state: dict) -> dict:
        drill = state.get("restoreDrill", {})
        last = parse_time(drill.get("lastSuccessAt"))
        if drill.get("status") == "error":
            return self.check("restore-drill", "Backup restore drill", "critical", drill.get("error") or "last restore drill failed")
        if not last:
            return self.check("restore-drill", "Backup restore drill", "degraded", "no successful restore drill recorded")
        age = now() - last
        status = "healthy" if age < dt.timedelta(days=14) else "degraded"
        return self.check("restore-drill", "Backup restore drill", status, f"last verified {round(age.total_seconds() / 86400, 1)} days ago")

    @staticmethod
    def check(check_id: str, name: str, status: str, detail: str, metrics: dict | None = None) -> dict:
        value = {"id": check_id, "name": name, "status": status, "detail": str(detail)[:500], "checkedAt": iso()}
        if metrics:
            value["metrics"] = metrics
        return value

    def monitor(self) -> dict:
        if self.request_file.exists():
            self.backup()
        if self.restore_request_file.exists():
            self.restore_drill()
        with self.locked():
            previous = self.load()
            checks = [
                self.check_http(self.health_url, "api", "Agentic OS internal API", include_providers=True),
                self.check_container("agentic-os", "Agentic OS container"),
                self.check_container("agentos-runtime", "Agent runtime container"),
                self.check_container("agentic-os-postgres", "PostgreSQL persistence"),
                self.check_service("hermes-dashboard.service", "Hermes Dashboard"),
                self.check_service("agentic-os-hermes-chat.service", "Hermes text bridge"),
                self.check_disk(),
                self.check_backup(previous),
                self.check_restore_drill(previous),
            ]
            if self.public_health_url:
                checks.insert(1, self.check_http(self.public_health_url, "public-api", "Public HTTPS endpoint"))
            statuses = {item["status"] for item in checks}
            overall = "critical" if "critical" in statuses else "degraded" if "degraded" in statuses else "healthy"
            incidents = self.update_incidents(previous.get("incidents", []), checks)
            state = {
                **previous,
                "version": 1,
                "status": overall,
                "checkedAt": iso(),
                "checks": checks,
                "incidents": incidents[-50:],
                "activeIncidents": sum(1 for incident in incidents if incident.get("status") == "active"),
                "schedule": {"monitorEveryMinutes": 5, "backupDailyAt": "03:15", "timezone": "server local time"},
            }
            old_status = previous.get("status")
            self.save(state)
            if (old_status and old_status != overall) or (not old_status and overall != "healthy"):
                summary = ", ".join(item["name"] for item in checks if item["status"] != "healthy") or "all checks recovered"
                self.notify("recovery" if overall == "healthy" else overall, f"Agentic OS status: {overall}. {summary}")
            return state

    @staticmethod
    def update_incidents(existing: list, checks: list[dict]) -> list[dict]:
        incidents = [dict(item) for item in existing if isinstance(item, dict)]
        active = {item.get("checkId"): item for item in incidents if item.get("status") == "active"}
        checked_at = iso()
        for check in checks:
            current = active.get(check["id"])
            if check["status"] == "healthy":
                if current:
                    current.update({"status": "resolved", "resolvedAt": checked_at, "lastSeenAt": checked_at})
                continue
            if current:
                current.update({"severity": check["status"], "message": check["detail"], "lastSeenAt": checked_at})
            else:
                incidents.append({
                    "id": f"{check['id']}-{int(now().timestamp())}", "checkId": check["id"], "name": check["name"],
                    "severity": check["status"], "message": check["detail"], "status": "active",
                    "firstSeenAt": checked_at, "lastSeenAt": checked_at,
                })
        return incidents

    def notify(self, severity: str, message: str) -> None:
        webhook = os.environ.get("OPS_ALERT_WEBHOOK_URL", "").strip()
        telegram_token = os.environ.get("OPS_TELEGRAM_BOT_TOKEN", "").strip()
        telegram_chat = os.environ.get("OPS_TELEGRAM_CHAT_ID", "").strip()
        if webhook:
            self.post_json(webhook, {"text": f"[{severity.upper()}] {message}"})
        if telegram_token and telegram_chat:
            self.post_json(f"https://api.telegram.org/bot{telegram_token}/sendMessage", {"chat_id": telegram_chat, "text": f"[{severity.upper()}] {message}"})

    @staticmethod
    def post_json(url: str, payload: dict) -> None:
        try:
            request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=8):
                pass
        except (OSError, urllib.error.URLError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["monitor", "backup", "restore-drill", "status"])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args()
    root = Path(args.root)
    load_project_env(root)
    operations = Operations(root)
    if args.command == "monitor":
        value = operations.monitor()
    elif args.command == "backup":
        value = operations.backup()
    elif args.command == "restore-drill":
        value = operations.restore_drill()
    else:
        value = operations.load()
    print(json.dumps(value, ensure_ascii=True))


if __name__ == "__main__":
    main()
