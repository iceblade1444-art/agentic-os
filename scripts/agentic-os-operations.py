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
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import urllib.parse


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
        # Off-site copy. Until this existed every backup lived on the same disk
        # as production — including the .env with every provider credential in
        # it — so one disk failure took the data and its only copies together.
        # Both settings are optional and independent: encryption without a
        # remote still protects the archive on disk, and a remote without a
        # passphrase is refused rather than shipping secrets in the clear.
        self.backup_passphrase_file = os.environ.get("OPS_BACKUP_PASSPHRASE_FILE", "").strip()
        self.backup_remote = os.environ.get("OPS_BACKUP_REMOTE", "").strip()
        self.offsite_max_age_hours = max(1, int(os.environ.get("OPS_OFFSITE_MAX_AGE_HOURS", "36")))
        bind = os.environ.get("BIND_ADDRESS", "127.0.0.1")
        if bind in {"0.0.0.0", "::"}:
            bind = "127.0.0.1"
        self.health_url = os.environ.get("OPS_HEALTH_URL", f"http://{bind}:{os.environ.get('HOST_PORT', '8787')}/api/health")
        self.public_health_url = os.environ.get("OPS_PUBLIC_HEALTH_URL", "").strip()
        self.auth_token = os.environ.get("AGENTIC_OS_TOKEN", "") or os.environ.get("AUTH_TOKEN", "")
        livekit_url = os.environ.get("OPS_LIVEKIT_URL", "") or os.environ.get("LIVEKIT_URL", "http://127.0.0.1:7880")
        self.livekit_url = livekit_url.replace("host.docker.internal", "127.0.0.1")
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
        try:
            return subprocess.run(args, cwd=self.root, text=True, capture_output=True, timeout=timeout, check=False)
        except FileNotFoundError as error:
            # A missing helper binary is an absent capability, not a crash: the
            # backup runs inside the app container too, where docker does not
            # exist, and losing the whole archive over one optional probe would
            # be far worse than skipping it.
            return subprocess.CompletedProcess(args, 127, "", f"{args[0]}: not found ({error})")

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

                hermes_archive = self.hermes_control_backup(destination)
                if hermes_archive:
                    archives.append(hermes_archive.name)

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

                # After the manifest, so the off-site archive always contains a
                # complete, self-describing backup.
                previous_offsite = self.load().get("offsite", {})
                offsite = self.offsite_backup(destination)
                if offsite.get("status") != "success" and previous_offsite.get("lastSuccessAt"):
                    offsite["lastSuccessAt"] = previous_offsite["lastSuccessAt"]

                removed = self.prune(destination)
                state = self.load()
                state["backup"] = {
                    "status": "success", "lastSuccessAt": completed, "path": str(destination),
                    "sizeBytes": size, "count": self.backup_count(), "retentionDays": self.retention_days,
                    "maxCount": self.max_backups, "removed": removed, "error": None,
                }
                state["offsite"] = offsite
                self.save(state)
                return state["backup"]
            except Exception as error:
                state = self.load()
                state["backup"] = {**state.get("backup", {}), "status": "error", "failedAt": iso(), "error": str(error)[:500]}
                self.save(state)
                self.notify("critical", f"Agentic OS backup failed: {error}")
                raise

    def backup_passphrase(self) -> str:
        """The symmetric key for off-site archives, read from a file only.

        A file keeps the passphrase out of the process table and out of the
        state JSON. It is never written into a backup — an archive that carries
        the key to itself is not encrypted, it is obfuscated.
        """
        if not self.backup_passphrase_file:
            return ""
        try:
            return Path(self.backup_passphrase_file).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeError(f"backup passphrase file unreadable: {error}") from error

    def encrypt_backup(self, destination: Path) -> Path | None:
        """Seal one backup directory into a single encrypted archive.

        Returns None when no passphrase is configured, which keeps this whole
        feature opt-in. gpg symmetric AES-256 is used because it ships with the
        distribution and authenticates what it encrypts; composing our own
        cipher and MAC here would be the wrong kind of clever.
        """
        passphrase = self.backup_passphrase()
        if not passphrase:
            return None
        if self.run("gpg", "--version").returncode != 0:
            raise RuntimeError("gpg is not installed, so the backup cannot be encrypted for off-site storage")

        archive = self.backup_root / f"{destination.name}.tar.gz"
        sealed = self.backup_root / f"{destination.name}.tar.gz.gpg"
        try:
            with tarfile.open(archive, "w:gz", compresslevel=6) as bundle:
                bundle.add(destination, arcname=destination.name, recursive=True)
            os.chmod(archive, 0o600)
            result = subprocess.run(
                [
                    "gpg", "--batch", "--yes", "--quiet",
                    "--symmetric", "--cipher-algo", "AES256",
                    "--passphrase-fd", "0",
                    "--output", str(sealed), str(archive),
                ],
                input=passphrase,
                text=True,
                capture_output=True,
                timeout=1800,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(f"gpg failed: {(result.stderr or '').strip()[:200]}")
            os.chmod(sealed, 0o600)
            return sealed
        finally:
            # The plaintext tarball is scratch space; only the sealed file is kept.
            with contextlib.suppress(FileNotFoundError):
                archive.unlink()

    def offsite_copy(self, sealed: Path) -> str | None:
        """Send the sealed archive somewhere this server cannot destroy.

        A remote starting with a scheme (s3:, b2:, any rclone remote written as
        name:path) goes through rclone; anything else is treated as a directory,
        which covers a mounted second disk or an NFS share without extra tools.
        """
        if not self.backup_remote:
            return None

        if ":" in self.backup_remote and not Path(self.backup_remote).is_absolute():
            if self.run("rclone", "version").returncode != 0:
                raise RuntimeError("rclone is not installed, so the encrypted backup cannot be uploaded")
            target = f"{self.backup_remote.rstrip('/')}/{sealed.name}"
            result = self.run("rclone", "copyto", str(sealed), target, timeout=3600)
            if result.returncode != 0:
                raise RuntimeError(f"rclone failed: {(result.stderr or '').strip()[:200]}")
            return target

        target_dir = Path(self.backup_remote).expanduser()
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / sealed.name
        # Write beside the target and rename, so a half-copied file is never
        # mistaken for a usable backup.
        staging = target_dir / f".{sealed.name}.partial"
        shutil.copy2(sealed, staging)
        os.replace(staging, target)
        return str(target)

    def offsite_backup(self, destination: Path) -> dict:
        """Encrypt and ship. Never raises: a local backup that succeeded must
        still be recorded as a success, with the off-site failure reported
        separately and loudly."""
        if not self.backup_passphrase_file and not self.backup_remote:
            return {"status": "disabled"}
        if self.backup_remote and not self.backup_passphrase_file:
            message = "OPS_BACKUP_REMOTE is set without OPS_BACKUP_PASSPHRASE_FILE — refusing to send an unencrypted backup containing .env"
            self.notify("critical", f"Agentic OS off-site backup refused: {message}")
            return {"status": "error", "error": message, "failedAt": iso()}

        try:
            sealed = self.encrypt_backup(destination)
            if sealed is None:
                return {"status": "disabled"}
            record = {
                "status": "success",
                "encryptedAt": iso(),
                "archive": sealed.name,
                "sizeBytes": sealed.stat().st_size,
                "remote": None,
                "lastSuccessAt": iso(),
            }
            target = self.offsite_copy(sealed)
            if target:
                record["remote"] = target
                record["uploadedAt"] = iso()
            return record
        except Exception as error:  # noqa: BLE001 - reported, never fatal
            self.notify("critical", f"Agentic OS off-site backup failed: {error}")
            return {"status": "error", "error": str(error)[:500], "failedAt": iso()}

    def postgres_dump(self, destination: Path) -> Path | None:
        inspect = self.run("docker", "inspect", "--format", "{{.State.Running}}", "agentic-os-postgres")
        if inspect.returncode != 0 or inspect.stdout.strip() != "true":
            return None
        user = os.environ.get("POSTGRES_USER", "agentic_os")
        database = os.environ.get("POSTGRES_DB", "agentic_os")
        target = destination / "postgres.dump"
        try:
            with target.open("wb") as output:
                result = subprocess.run(
                    ["docker", "exec", "agentic-os-postgres", "pg_dump", "-U", user, "-d", database, "--format=custom"],
                    cwd=self.root,
                    stdout=output,
                    stderr=subprocess.PIPE,
                    timeout=120,
                    check=False,
                )
        except FileNotFoundError:
            target.unlink(missing_ok=True)
            return None
        if result.returncode != 0:
            target.unlink(missing_ok=True)
            raise RuntimeError(f"PostgreSQL backup failed: {result.stderr.decode('utf-8', 'replace')[:300]}")
        os.chmod(target, 0o600)
        return target

    def hermes_control_backup(self, destination: Path) -> Path | None:
        """Archive recoverable Hermes state without copying provider credentials."""
        hermes_home = Path(os.environ.get("OPS_HERMES_HOME", Path.home() / ".hermes")).expanduser().resolve()
        if not hermes_home.is_dir():
            return None

        with tempfile.TemporaryDirectory(prefix="hermes-backup-", dir=self.state_dir) as temp_dir:
            stage = Path(temp_dir) / "hermes"
            stage.mkdir(mode=0o700)

            self._copy_regular_file(hermes_home / "SOUL.md", stage / "SOUL.md")
            self._copy_markdown_tree(hermes_home / "memories", stage / "memories")
            self._copy_regular_file(hermes_home / "cron" / "jobs.json", stage / "cron" / "jobs.json")
            self._copy_markdown_tree(hermes_home / "cron" / "output", stage / "cron" / "output")

            profiles_root = hermes_home / "profiles"
            if profiles_root.is_dir() and not profiles_root.is_symlink():
                for profile in profiles_root.iterdir():
                    if not profile.is_dir() or profile.is_symlink():
                        continue
                    profile_stage = stage / "profiles" / profile.name
                    self._copy_regular_file(profile / "SOUL.md", profile_stage / "SOUL.md")
                    self._copy_regular_file(profile / "profile.yaml", profile_stage / "profile.yaml")
                    self._copy_markdown_tree(profile / "memories", profile_stage / "memories")

            for relative in ("cron/executions.db", "kanban.db", "projects.db"):
                source = hermes_home / relative
                if source.is_file() and not source.is_symlink():
                    self._sqlite_online_backup(source, stage / relative)

            if not any(item.is_file() for item in stage.rglob("*")):
                return None
            archive = destination / "hermes-control.tgz"
            with tarfile.open(archive, "w:gz", compresslevel=6) as bundle:
                bundle.add(stage, arcname="hermes", recursive=True, filter=self._tar_filter)
            os.chmod(archive, 0o600)
            return archive

    @staticmethod
    def _copy_regular_file(source: Path, target: Path) -> None:
        if not source.is_file() or source.is_symlink():
            return
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(source, target)
        os.chmod(target, 0o600)

    def _copy_markdown_tree(self, source: Path, target: Path) -> None:
        if not source.is_dir() or source.is_symlink():
            return
        for item in source.rglob("*.md"):
            if not item.is_file() or item.is_symlink():
                continue
            relative = item.relative_to(source)
            if ".." in relative.parts:
                continue
            self._copy_regular_file(item, target / relative)

    @staticmethod
    def _sqlite_online_backup(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
            with sqlite3.connect(target) as target_db:
                source_db.backup(target_db)
        os.chmod(target, 0o600)

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

    def fetch_offsite_backup(self, work_dir: Path) -> Path:
        """Download, decrypt and unpack the newest off-site archive.

        These are the first three steps of a real recovery, so any of them
        failing is the finding: an archive that cannot make this trip is not a
        backup, however faithfully it was uploaded.
        """
        if not self.backup_passphrase_file:
            raise RuntimeError("no passphrase is configured, so the off-site archive cannot be opened")

        rclone_style = ":" in self.backup_remote and not Path(self.backup_remote).is_absolute()
        if rclone_style:
            listing = self.run("rclone", "lsf", "--log-level", "ERROR", self.backup_remote, timeout=300)
            if listing.returncode != 0:
                raise RuntimeError((listing.stderr or "").strip()[:200] or "cannot list the off-site remote")
            names = sorted(line.strip() for line in listing.stdout.splitlines()
                           if line.strip().endswith(".tar.gz.gpg"))
            if not names:
                raise RuntimeError("the off-site remote holds no archive")
            sealed = work_dir / names[-1]
            fetched = self.run("rclone", "copyto", "--log-level", "ERROR",
                               f"{self.backup_remote.rstrip('/')}/{names[-1]}",
                               str(sealed), timeout=1800)
            if fetched.returncode != 0:
                raise RuntimeError((fetched.stderr or "").strip()[:200] or "cannot download the off-site archive")
        else:
            remote_dir = Path(self.backup_remote).expanduser()
            names = sorted(item.name for item in remote_dir.glob("*.tar.gz.gpg"))
            if not names:
                raise RuntimeError("the off-site directory holds no archive")
            sealed = work_dir / names[-1]
            shutil.copy2(remote_dir / names[-1], sealed)

        tarball = work_dir / "offsite.tar.gz"
        with open(tarball, "wb") as plain:
            opened = subprocess.run(
                ["gpg", "--batch", "--quiet", "--yes", "--decrypt",
                 "--passphrase-file", self.backup_passphrase_file, str(sealed)],
                stdout=plain, stderr=subprocess.PIPE, timeout=900, check=False)
        if opened.returncode != 0 or not tarball.stat().st_size:
            detail = opened.stderr.decode("utf-8", "replace").strip()[:200]
            raise RuntimeError(f"cannot decrypt the off-site archive: {detail}")

        unpacked = work_dir / "unpacked"
        unpacked.mkdir()
        with tarfile.open(tarball, "r:gz") as bundle:
            for member in bundle.getmembers():
                self.assert_safe_tar_member(member)
            bundle.extractall(unpacked)
        directories = [item for item in unpacked.iterdir() if item.is_dir()]
        if len(directories) != 1:
            raise RuntimeError("the off-site archive does not hold exactly one backup")
        return directories[0]

    def restore_drill(self, backup_path: Path | None = None) -> dict:
        with self.locked():
            self.restore_request_file.unlink(missing_ok=True)
            fetched_dir = None
            state = self.load()
            state["restoreDrill"] = {**state.get("restoreDrill", {}), "status": "running", "startedAt": iso(), "error": None}
            self.save(state)

            try:
                # An explicitly named backup is always honoured; otherwise the
                # copy worth rehearsing is the one that survives this server.
                source, offsite_error, fetched_dir = "local", None, None
                selected = backup_path
                if selected is None and self.backup_remote:
                    try:
                        fetched_dir = Path(tempfile.mkdtemp(prefix="agentic-os-offsite-", dir=self.state_dir))
                        selected = self.fetch_offsite_backup(fetched_dir)
                        source = "off-site"
                    except Exception as error:  # noqa: BLE001 - fall back, and say so
                        offsite_error = str(error)[:300]
                        selected = None
                        shutil.rmtree(fetched_dir, ignore_errors=True)
                        fetched_dir = None
                if selected is None:
                    selected = self.latest_backup()
                if not selected:
                    raise RuntimeError("no backup is available for restore drill")
                selected = selected.resolve()
                # The containment rule guards against being pointed at an
                # arbitrary path; the off-site copy is exempt because we just
                # unpacked it ourselves, into our own temporary directory.
                if source == "local" and (not selected.is_dir() or self.backup_root not in selected.parents):
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
                    "source": source,
                    "offsiteError": offsite_error,
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
            finally:
                if fetched_dir:
                    shutil.rmtree(fetched_dir, ignore_errors=True)

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
                # The sealed copy is part of the same backup and must age out
                # with it, or the local disk fills with encrypted archives whose
                # directories are long gone.
                sealed = self.backup_root / f"{item.name}.tar.gz.gpg"
                with contextlib.suppress(FileNotFoundError):
                    sealed.unlink()
        self.prune_offsite(removed)
        return removed

    def prune_offsite(self, removed: list[str]) -> None:
        """Let the remote forget what this disk has already forgotten.

        Retention only ever applied locally, so the destination grew without
        bound. On a free-tier quota that ends with the upload failing, which is
        the worst way for a backup to stop: everything still succeeds locally
        and the off-site copy simply stops arriving.

        Never raises, and never alerts. A stale archive in the remote is a
        smaller problem than a backup reported failed because its cleanup was.
        """
        if not removed or not self.backup_remote:
            return
        rclone_style = ":" in self.backup_remote and not Path(self.backup_remote).is_absolute()
        for name in removed:
            archive = f"{name}.tar.gz.gpg"
            try:
                if rclone_style:
                    target = f"{self.backup_remote.rstrip('/')}/{archive}"
                    # --log-level ERROR keeps rclone's standing advisories out of
                    # stderr, so what is left there is the actual reason.
                    result = self.run("rclone", "deletefile", "--log-level", "ERROR",
                                      target, timeout=300)
                    if result.returncode != 0:
                        detail = (result.stderr or "").strip()
                        # Nothing to delete is the normal case: every backup older
                        # than the destination itself was never sent there.
                        if "not found" in detail.lower():
                            continue
                        raise RuntimeError(detail[:200] or "rclone deletefile failed")
                else:
                    with contextlib.suppress(FileNotFoundError):
                        (Path(self.backup_remote).expanduser() / archive).unlink()
            except Exception as error:  # noqa: BLE001 - cleanup must not fail a backup
                print(f"could not remove off-site copy {archive}: {error}", file=sys.stderr)

    def fetch_json(self, url: str, authenticated: bool = False) -> tuple[int, dict]:
        headers = {"Accept": "application/json"}
        if authenticated and self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, json.loads(response.read(256_000))

    def check_http(self, url: str, check_id: str, label: str, include_providers: bool = False) -> dict:
        try:
            status_code, payload = self.fetch_json(url)
            if status_code != 200 or not payload.get("ok"):
                raise RuntimeError(f"HTTP {status_code}")
            providers = payload.get("providers", {})
            detail = "API ready"
            if include_providers and providers.get("hermes"):
                detail += ", Hermes provider ready"
            return self.check(check_id, label, "healthy", detail)
        except Exception as error:
            return self.check(check_id, label, "critical", str(error))

    def check_capability(self, pathname: str, check_id: str, label: str, evaluator) -> dict:
        if not self.auth_token:
            return self.check(check_id, label, "degraded", "authenticated operations token is not configured")
        try:
            base = self.health_url.rsplit("/api/health", 1)[0]
            status_code, payload = self.fetch_json(f"{base}{pathname}", authenticated=True)
            if status_code != 200:
                raise RuntimeError(f"HTTP {status_code}")
            healthy, detail = evaluator(payload)
            return self.check(check_id, label, "healthy" if healthy else "critical", detail)
        except Exception as error:
            return self.check(check_id, label, "critical", str(error))

    def check_livekit(self) -> dict:
        try:
            parsed = urllib.parse.urlparse(self.livekit_url)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or (443 if parsed.scheme in {"https", "wss"} else 80)
            with socket.create_connection((host, port), timeout=5):
                pass
            return self.check("livekit", "LiveKit signaling", "healthy", f"{host}:{port} reachable")
        except Exception as error:
            return self.check("livekit", "LiveKit signaling", "critical", str(error))

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

    def check_offsite(self, state: dict) -> dict:
        offsite = state.get("offsite", {})
        name = "Off-site backup copy"
        # Not configured is a real state, but not a healthy one: it means the
        # only copies of the data sit on the same disk as production.
        if not self.backup_passphrase_file and not self.backup_remote:
            return self.check("offsite", name, "degraded", "not configured — backups exist only on this server")
        if offsite.get("status") == "error":
            return self.check("offsite", name, "critical", offsite.get("error") or "last off-site copy failed")
        last = parse_time(offsite.get("lastSuccessAt"))
        if not last:
            return self.check("offsite", name, "degraded", "no successful off-site copy recorded")
        age = now() - last
        status = "healthy" if age < dt.timedelta(hours=self.offsite_max_age_hours) else "degraded"
        target = "encrypted on disk" if not self.backup_remote else offsite.get("remote") or self.backup_remote
        return self.check("offsite", name, status, f"last copy {round(age.total_seconds() / 3600, 1)}h ago → {target}")

    def check_restore_drill(self, state: dict) -> dict:
        drill = state.get("restoreDrill", {})
        last = parse_time(drill.get("lastSuccessAt"))
        if drill.get("status") == "error":
            return self.check("restore-drill", "Backup restore drill", "critical", drill.get("error") or "last restore drill failed")
        if not last:
            return self.check("restore-drill", "Backup restore drill", "degraded", "no successful restore drill recorded")
        age = now() - last
        status = "healthy" if age < dt.timedelta(days=14) else "degraded"
        source = drill.get("source", "local")
        detail = f"last verified {round(age.total_seconds() / 86400, 1)} days ago, {source} copy"
        # Rehearsing the archive that sits beside production is not what the
        # off-site copy promises. Falling back to it is allowed — reporting a
        # clean bill for the wrong archive is not.
        if self.backup_remote and source != "off-site":
            status = "degraded"
            reason = drill.get("offsiteError") or "the off-site copy was not rehearsed"
            detail = f"{detail} — {reason}"
        return self.check("restore-drill", "Backup restore drill", status, detail)

    @staticmethod
    def check(check_id: str, name: str, status: str, detail: str, metrics: dict | None = None) -> dict:
        value = {"id": check_id, "name": name, "status": status, "detail": str(detail)[:500], "checkedAt": iso()}
        if metrics:
            value["metrics"] = metrics
        return value

    def check_ssh_keys(self, state: dict) -> dict:
        """Report junk lines and unrecognised keys in authorized_keys."""
        name = "SSH authorized keys"
        path = Path.home() / ".ssh/authorized_keys"
        if not path.is_file():
            return self.check("ssh-keys", name, "critical", "authorized_keys is missing")

        listed = self.run("ssh-keygen", "-l", "-f", str(path), timeout=30)
        if listed.returncode != 0:
            detail = (listed.stderr or "").strip()[:150] or "authorized_keys could not be read"
            return self.check("ssh-keys", name, "critical", detail)

        entries = [line.split() for line in listed.stdout.splitlines() if line.strip()]
        seen = {parts[1]: " ".join(parts[2:-1]) or "unnamed" for parts in entries}
        self.ssh_keys_seen = seen

        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        meaningful = [line for line in lines if line.strip() and not line.lstrip().startswith("#")]
        junk = len(meaningful) - len(entries)
        mode = path.stat().st_mode & 0o777

        expected = os.environ.get("OPS_SSH_KEYS_EXPECTED", "").strip()
        known = {fp.strip() for fp in expected.split(",") if fp.strip()} or set(
            (state.get("sshKeys") or {}).keys())

        problems = []
        status = "healthy"

        if mode & 0o077:
            # sshd refuses a group- or world-readable file, so this locks
            # everyone out rather than letting anyone in — still critical.
            status = "critical"
            problems.append(f"permissions are {mode:o}, must be 600")

        if not known:
            # First run: record what is here rather than inventing an alert
            # about a state nobody has declared wrong.
            problems.append(f"{len(seen)} keys recorded as the baseline")
        else:
            appeared = {fp: who for fp, who in seen.items() if fp not in known}
            vanished = [fp for fp in known if fp not in seen]
            if appeared:
                status = "critical"
                problems.append("unrecognised key: " + ", ".join(
                    f"{who} {fp[:24]}…" for fp, who in appeared.items()))
            if vanished:
                status = "degraded" if status == "healthy" else status
                problems.append(f"{len(vanished)} recorded key(s) no longer present")

        if junk > 0:
            status = "degraded" if status == "healthy" else status
            problems.append(f"{junk} line(s) sshd cannot parse")

        detail = f"{len(seen)} keys" + ("; " + "; ".join(problems) if problems else "")
        return self.check("ssh-keys", name, status, detail,
                          metrics={"keys": len(seen), "unparsedLines": junk})

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
                self.check_capability(
                    "/api/integrations/mila/status", "mila", "MILA voice backend",
                    lambda payload: (
                        payload.get("ok") is True and payload.get("voiceConfigured") is True,
                        f"backend ok={payload.get('ok') is True}, voice={payload.get('voiceConfigured') is True}",
                    ),
                ),
                self.check_livekit(),
                self.check_capability(
                    "/api/knowledge/status", "obsidian", "Obsidian vault",
                    lambda payload: (
                        payload.get("writable") is True,
                        f"{payload.get('notes', 0)} notes, writable={payload.get('writable') is True}",
                    ),
                ),
                self.check_disk(),
                self.check_backup(previous),
                self.check_offsite(previous),
                self.check_restore_drill(previous),
                self.check_ssh_keys(previous),
            ]
            if self.public_health_url:
                checks.insert(1, self.check_http(self.public_health_url, "public-api", "Public HTTPS endpoint"))
            statuses = {item["status"] for item in checks}
            overall = "critical" if "critical" in statuses else "degraded" if "degraded" in statuses else "healthy"
            incidents = self.update_incidents(previous.get("incidents", []), checks)
            state = {
                **previous,
                # Written once. A key that appeared unexpectedly must not become
                # the new normal on the next run — that turns an alarm into a
                # single blink nobody was watching for.
                "sshKeys": previous.get("sshKeys") or getattr(self, "ssh_keys_seen", None) or {},
                "version": 1,
                "status": overall,
                "checkedAt": iso(),
                "checks": checks,
                "incidents": incidents[-50:],
                "activeIncidents": sum(1 for incident in incidents if incident.get("status") == "active"),
                "schedule": {
                    "monitorEveryMinutes": 5, "backupDailyAt": "03:15",
                    "deepCheckDailyAt": "04:00", "timezone": "server local time",
                },
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
