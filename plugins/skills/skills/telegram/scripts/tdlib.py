#!/usr/bin/env python3
"""Agent-neutral TDLib sessions. Credentials and runtime overrides come from the supplied process environment."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import getpass
import json
import os
import platform
import stat
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, NamedTuple

BASE_STATE_ROOT = Path(os.environ.get('TDLIB_STATE_DIR') or str(Path(os.environ.get('XDG_DATA_HOME') or str(Path.home() / '.local/share')) / 'tdlib')).expanduser().resolve()
LIB_ROOT = Path(os.environ.get('TDLIB_ROOT') or str(Path.home() / '.local/lib/tdlib')).expanduser().resolve()
_active_session = threading.Lock()
_failed_session = None
_resolved_secrets = {}


class TelegramError(RuntimeError):
    pass


class TDLibError(TelegramError):
    """A server/library error; code is preserved for task-specific handling."""
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = redact_secret_values(message)
        super().__init__(f"TDLib error {code}: {self.message}")


class NotConfigured(TelegramError):
    pass


class NotAuthorized(TelegramError):
    pass


class RuntimePaths(NamedTuple):
    account: str
    root: Path
    db: Path
    files: Path


def validate_account(value: str) -> str:
    if not value or value in {".", ".."}:
        raise TelegramError("account name must not be empty")
    if len(value) > 64 or not all(ch.isdigit() or ch == "_" or ("a" <= ch <= "z") for ch in value):
        raise TelegramError("account name may contain only lowercase letters, numbers, and '_'")
    return value


def runtime_paths(account: str) -> RuntimePaths:
    safe = validate_account(account)
    root = BASE_STATE_ROOT / "accounts" / safe
    return RuntimePaths(
        account=safe,
        root=root,
        db=root / "db",
        files=root / "files",
    )


def ensure_dirs(paths: RuntimePaths) -> None:
    for directory in (paths.root, paths.db, paths.files):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)


def atomic_text(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)


def validate_owner_regular_file(path: Path) -> None:
    if path.is_symlink():
        raise TelegramError(f"{path} must be an owner-controlled regular file, not a symlink")
    if path.exists():
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise TelegramError(f"{path} must be a regular file")
        if metadata.st_uid != os.getuid():
            raise TelegramError(f"{path} must be owned by uid {os.getuid()}")


_SECRET_SUFFIXES = ('_HASH', '_TOKEN', '_KEY', '_PASSWORD', '_SECRET')
_MIN_REDACT_LEN = 6


def redact_secret_values(text: str, values=None) -> str:
    selected = os.environ if values is None else values
    secrets = {
        value for key, value in selected.items()
        if isinstance(value, str) and len(value) >= _MIN_REDACT_LEN
        and key.upper().startswith('TDLIB_')
        and any(key.upper().endswith(suffix) for suffix in _SECRET_SUFFIXES)
    }
    if values is None:
        secrets.update(v for v in _resolved_secrets if isinstance(v, str) and len(v) >= _MIN_REDACT_LEN)
    # A shorter secret replaced first can expose the suffix of a longer one.
    for value in sorted(secrets, key=len, reverse=True):
        text = text.replace(value, '[REDACTED]')
    return text


def load_credentials(paths: RuntimePaths) -> dict[str, Any]:
    required = ('TDLIB_API_ID', 'TDLIB_API_HASH', 'TDLIB_DATABASE_KEY')
    settings = {name: os.environ[name] for name in required + ('TDLIB_BOT_TOKEN',) if name in os.environ}
    for name, value in settings.items():
        if value and name.endswith(('_HASH', '_TOKEN', '_KEY')):
            _resolved_secrets[value] = value
    missing = [name for name in required if not settings.get(name)]
    if missing:
        raise NotConfigured('Missing environment variables: ' + ', '.join(missing))
    try:
        api_id = int(settings['TDLIB_API_ID'])
        if api_id <= 0:
            raise ValueError
    except ValueError:
        raise NotConfigured('TDLIB_API_ID must be a positive integer') from None
    token = settings.get('TDLIB_BOT_TOKEN', '')
    result = {'api_id': api_id, 'api_hash': settings['TDLIB_API_HASH'],
              'database_encryption_key': settings['TDLIB_DATABASE_KEY'],
              'account_type': 'bot' if token else 'user'}
    if token:
        result['bot_token'] = token
    path = paths.root / 'identity.json'
    if path.exists() or path.is_symlink():
        validate_owner_regular_file(path)
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise NotConfigured('identity.json must be owner-only (0600)')
        identity = json.loads(path.read_text())
        if (not isinstance(identity, dict) or set(identity) != {'user_id', 'is_bot'}
                or type(identity.get('user_id')) is not int
                or identity['user_id'] <= 0 or type(identity.get('is_bot')) is not bool):
            raise NotConfigured('Invalid identity.json')
        if identity['is_bot'] != bool(token):
            raise NotConfigured('Configured account type does not match saved identity')
        result.update(expected_user_id=identity['user_id'], expected_is_bot=identity['is_bot'])
    return result


def locate_library() -> Path:
    path = LIB_ROOT / 'libtdjson.so'
    if not path.is_file():
        raise NotConfigured('TDLib library not found: ' + str(path))
    return path.resolve()


def installed_tdlib_commit() -> str:
    """Ask the library synchronously; no client, credentials or database needed."""
    library = ctypes.CDLL(str(locate_library()))
    library.td_execute.argtypes = [ctypes.c_char_p]
    library.td_execute.restype = ctypes.c_char_p
    raw = library.td_execute(b'{"@type":"getOption","name":"commit_hash"}')
    result = json.loads(raw) if raw else {}
    commit = result.get('value', '')
    if (result.get('@type') != 'optionValueString' or not isinstance(commit, str)
            or len(commit) != 40 or any(ch not in '0123456789abcdef' for ch in commit)):
        raise NotConfigured('TDLib did not return a valid source commit')
    return commit


def persist_telegram_identity(paths: RuntimePaths, identity: dict[str, Any]) -> None:
    path = paths.root / 'identity.json'
    validate_owner_regular_file(path)
    saved = {'user_id': identity['user_id'], 'is_bot': identity['is_bot']}
    atomic_text(path, json.dumps(saved, sort_keys=True) + '\n')


def telegram_identity(user: dict[str, Any]) -> dict[str, Any]:
    user_type = (user.get("type") or {}).get("@type")
    usernames = ((user.get("usernames") or {}).get("active_usernames") or [])
    return {
        "user_id": int(user["id"]),
        "is_bot": user_type == "userTypeBot",
        "user_type": user_type,
        "first_name": user.get("first_name") or "",
        "last_name": user.get("last_name") or "",
        "usernames": usernames,
    }


def verify_telegram_identity(creds: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
    expected_user_id = creds.get("expected_user_id")
    expected_is_bot = creds.get("expected_is_bot")
    if expected_user_id is not None and int(expected_user_id) != int(identity["user_id"]):
        raise TelegramError(
            f"Telegram identity mismatch: expected user_id={expected_user_id}, got user_id={identity['user_id']}"
        )
    if expected_is_bot is not None and bool(expected_is_bot) != bool(identity["is_bot"]):
        raise TelegramError(
            f"Telegram identity mismatch: expected is_bot={bool(expected_is_bot)}, got is_bot={bool(identity['is_bot'])}"
        )
    return {
        **identity,
        "identity_verified": expected_user_id is not None and expected_is_bot is not None,
    }


class Client:
    """Native transport and update buffer. Open through session()."""
    def __init__(self, paths: RuntimePaths, *, updates=(), max_updates: int = 10000):
        if isinstance(updates, str) or max_updates < 1:
            raise ValueError('updates must be an iterable of types; max_updates must be positive')
        self.paths = paths
        self.update_types = frozenset(updates)
        self.max_updates = max_updates
        self._updates = []
        self._closing = self._closed = False
        self.path = locate_library()
        self.lib = ctypes.CDLL(str(self.path))
        self.lib.td_create_client_id.restype = ctypes.c_int
        self.lib.td_create_client_id.argtypes = []
        self.lib.td_send.restype = None
        self.lib.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
        self.lib.td_receive.restype = ctypes.c_char_p
        self.lib.td_receive.argtypes = [ctypes.c_double]
        self.lib.td_execute.restype = ctypes.c_char_p
        self.lib.td_execute.argtypes = [ctypes.c_char_p]
        self.client_id = int(self.lib.td_create_client_id())
        self.execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 1})

    def execute(self, request: dict[str, Any]) -> dict[str, Any] | None:
        result = self.lib.td_execute(json.dumps(request).encode())
        return json.loads(result.decode()) if result else None

    def send(self, request: dict[str, Any]) -> None:
        self.lib.td_send(self.client_id, json.dumps(request, ensure_ascii=False).encode())

    def receive(self, timeout: float = 1.0) -> dict[str, Any] | None:
        result = self.lib.td_receive(timeout)
        return json.loads(result.decode()) if result else None

    def handle_update(self, event: dict[str, Any]) -> None:
        if event.get('@type') == 'updateAuthorizationState':
            self._closed = event.get('authorization_state', {}).get('@type') == 'authorizationStateClosed'
        if not self._closing and event.get('@type') in self.update_types:
            if len(self._updates) >= self.max_updates:
                raise TelegramError('TDLib update buffer overflow; result is incomplete')
            self._updates.append(event)

    def request(self, request: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
        request_id = uuid.uuid4().hex
        payload = dict(request)
        payload["@extra"] = request_id
        self.send(payload)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = self.receive(min(1.0, max(0.05, deadline - time.monotonic())))
            if not event:
                continue
            if event.get("@extra") == request_id:
                if event.get("@type") == "error":
                    raise TDLibError(event.get('code'), event.get('message', 'unknown error'))
                return event
            self.handle_update(event)
        raise TelegramError(f"TDLib request timed out: {request.get('@type')}")

    def call(self, method: str, /, **params) -> dict[str, Any]:
        """Call a TDLib method; strip only top-level transport metadata."""
        result = self.request({**params, '@type': method})
        return {key: value for key, value in result.items() if key not in ('@extra', '@client_id')}

    def parameters(self, creds: dict[str, Any]) -> dict[str, Any]:
        return {
            "@type": "setTdlibParameters",
            "use_test_dc": False,
            "database_directory": str(self.paths.db),
            "files_directory": str(self.paths.files),
            "database_encryption_key": creds["database_encryption_key"],
            "use_file_database": True,
            "use_chat_info_database": True,
            "use_message_database": True,
            "use_secret_chats": False,
            "api_id": creds["api_id"],
            "api_hash": creds["api_hash"],
            "system_language_code": "en",
            "device_model": "TDLib Skill",
            "system_version": platform.platform(),
            "application_version": "0.9.3",
        }

    def authorize(self, creds: dict[str, Any], interactive: bool = False) -> str:
        while True:
            kind = self.request({'@type': 'getAuthorizationState'}).get('@type', 'unknown')
            if kind == 'authorizationStateReady':
                return kind
            if kind == 'authorizationStateWaitTdlibParameters':
                self.request(self.parameters(creds), timeout=120)
                continue
            if kind == 'authorizationStateWaitPhoneNumber' and creds.get('account_type') == 'bot':
                self.request({'@type': 'checkAuthenticationBotToken', 'token': creds['bot_token']})
                continue
            if kind not in ('authorizationStateWaitPhoneNumber', 'authorizationStateWaitCode', 'authorizationStateWaitPassword'):
                raise NotAuthorized(f'TDLib authorization is not usable or supported: {kind}')
            if not interactive:
                raise NotAuthorized(f'Telegram login required ({kind}); run login in an interactive terminal')
            if kind == 'authorizationStateWaitPhoneNumber':
                phone = input('Telegram phone number (international format): ').strip()
                self.request({'@type': 'setAuthenticationPhoneNumber', 'phone_number': phone, 'settings': None})
            elif kind == 'authorizationStateWaitCode':
                code = getpass.getpass('Telegram login code: ')
                self.request({'@type': 'checkAuthenticationCode', 'code': code})
                code = ''
            else:
                password = getpass.getpass('Telegram 2FA password: ')
                self.request({'@type': 'checkAuthenticationPassword', 'password': password})
                password = ''

    def close(self, timeout: float = 30.0) -> None:
        self._closing = True
        if self._closed:
            return
        request_id = uuid.uuid4().hex
        self.send({"@type": "close", "@extra": request_id})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = self.receive(min(1.0, max(0.05, deadline - time.monotonic())))
            if not event:
                continue
            if event.get("@type") == "updateAuthorizationState":
                state = event.get("authorization_state", {}).get("@type")
                if state == "authorizationStateClosed":
                    self._closed = True
                    return
            self.handle_update(event)
        raise TelegramError("TDLib did not reach authorizationStateClosed before timeout")


    def drain_updates(self):
        """Take all subscribed updates observed so far (does not poll the network)."""
        events, self._updates = self._updates, []
        return events

    def wait_update(self, event_type: str, *, timeout: float = 30):
        """Consume the first matching update, retaining other subscribed updates."""
        if event_type not in self.update_types:
            raise ValueError('Subscribe to the update type when opening session()')
        deadline = time.monotonic() + timeout
        while True:
            for index, event in enumerate(self._updates):
                if event.get('@type') == event_type:
                    return self._updates.pop(index)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TelegramError(f'TDLib update timed out: {event_type}')
            event = self.receive(min(1.0, remaining))
            if event:
                self.handle_update(event)

@contextlib.contextmanager
def session(account: str, *, updates=(), max_updates: int = 10000, login: bool = False):
    """Authorize a single account, verify saved identity, and close even on failure."""
    global _failed_session
    paths = runtime_paths(account)
    if _failed_session is not None:
        raise TelegramError('A previous close failed; terminate this process before retrying')
    if login and not os.environ.get('TDLIB_BOT_TOKEN') and not sys.stdin.isatty():
        raise TelegramError('login requires an interactive terminal')
    if not _active_session.acquire(blocking=False):
        raise TelegramError('Use only one session per process; open separate processes for other accounts')
    try:
        ensure_dirs(paths)
        creds = load_credentials(paths)
        interactive_login = login and creds.get('account_type', 'user') != 'bot'
        if interactive_login and not sys.stdin.isatty():
            raise TelegramError('login requires an interactive terminal')
        client = Client(paths, updates=updates, max_updates=max_updates)
        try:
            client.authorize(creds, interactive=interactive_login)
            identity = telegram_identity(client.request({'@type': 'getMe'}))
            if identity['is_bot'] != (creds.get('account_type', 'user') == 'bot'):
                raise TelegramError('Live identity does not match the configured account type')
            client.identity = verify_telegram_identity(creds, identity)
            if login:
                persist_telegram_identity(paths, identity)
                client.identity = verify_telegram_identity(load_credentials(paths), identity)
            if not client.identity['identity_verified']:
                raise TelegramError('Saved account identity is missing; use the existing login workflow')
            yield client
        finally:
            try:
                client.close()
            except BaseException:
                _failed_session = client
                raise
    finally:
        if _failed_session is None:
            _active_session.release()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description='TDLib login; API tasks import session()')
    root.add_argument('--account', default='personal')
    commands = root.add_subparsers(dest='command', required=True)
    commands.add_parser('login', help='log in interactively and record account identity')
    commands.add_parser('auth-status', help='verify live identity without interactive login')
    return root


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        with session(args.account, login=args.command == 'login') as td:
            result = {'account': args.account, 'authorization_state': 'authorizationStateReady', 'identity': td.identity}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except KeyboardInterrupt:
        return 130
    except (TelegramError, OSError, ValueError) as exc:
        print(f'Error: {redact_secret_values(str(exc))}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
