#!/usr/bin/env python3
"""Offline tests for the single-file TDLib base; no live account writes."""
import argparse
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).with_name('tdlib.py')
telegram = None
if PATH.exists():
    spec = importlib.util.spec_from_file_location('telegram_test_base', PATH)
    telegram = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(telegram)


def make_client(base, *, paths=None, **kwargs):
    """Exercise the real constructor without loading TDLib or touching disk."""
    with patch.object(base, 'locate_library', return_value=Path('/unused/libtdjson.so')), patch.object(base.ctypes, 'CDLL') as factory:
        factory.return_value.td_create_client_id.return_value = 1
        factory.return_value.td_execute.return_value = b'{"@type":"ok"}'
        return base.Client(paths or base.runtime_paths('personal'), **kwargs)


class CallTests(unittest.TestCase):
    def test_call_builds_request_and_cleans_only_top_level_metadata(self):
        td = make_client(telegram)
        nested = {'@type': 'nested', '@extra': 'business-data', '@client_id': 7}
        raw = {'@type': 'chat', 'id': 42, 'nested': nested, '@extra': 'request-id', '@client_id': 1}
        with patch.object(td, 'request', return_value=raw) as request:
            result = td.call('getChat', chat_id=42)
        request.assert_called_once_with({'@type': 'getChat', 'chat_id': 42})
        self.assertEqual(result, {'@type': 'chat', 'id': 42, 'nested': nested})
        self.assertIn('@extra', raw)
        self.assertIn('@client_id', raw)
        self.assertIsNot(result, raw)


    def test_call_forwards_fields_without_reserving_method_or_timeout(self):
        td = make_client(telegram)
        with patch.object(td, 'request', return_value={'@type': 'ok'}) as request:
            td.call('example', method='payload-method', timeout=12)
        request.assert_called_once_with({'@type': 'example', 'method': 'payload-method', 'timeout': 12})

    def test_call_propagates_errors_without_retry(self):
        td = make_client(telegram)
        for error in (telegram.TDLibError(404, 'Not Found'), telegram.TelegramError('timed out')):
            with self.subTest(error=type(error).__name__), patch.object(td, 'request', side_effect=error) as request:
                with self.assertRaises(type(error)) as caught:
                    td.call('getChat', chat_id=42)
                self.assertIs(caught.exception, error)
                request.assert_called_once()

    def test_call_retains_updates_and_request_remains_raw(self):
        td = make_client(telegram, updates=('updateChatFolders',))
        events = [
            {'@type': 'updateChatFolders', 'chat_folders': [], '@client_id': 1},
            {'@type': 'chat', 'id': 42, '@extra': 'correlation', '@client_id': 1},
            {'@type': 'chat', 'id': 42, '@extra': 'correlation', '@client_id': 1},
        ]
        with patch.object(td, 'send'), patch.object(td, 'receive', side_effect=events), patch.object(telegram.uuid, 'uuid4') as uid:
            uid.return_value.hex = 'correlation'
            self.assertEqual(td.call('getChat', chat_id=42), {'@type': 'chat', 'id': 42})
            raw = td.request({'@type': 'getChat', 'chat_id': 42})
        self.assertEqual(raw['@extra'], 'correlation')
        self.assertEqual(raw['@client_id'], 1)
        self.assertEqual(td.wait_update('updateChatFolders', timeout=0), events[0])


class LayoutTests(unittest.TestCase):
    def test_standalone_base_has_only_account_setup_cli(self):
        self.assertTrue(PATH.exists(), 'standalone tdlib.py is missing')
        self.assertFalse(hasattr(telegram, 'runtime'), 'base still depends on legacy runtime module')
        for name in ('session', 'Client', 'TDLibError', 'installed_tdlib_commit'):
            self.assertTrue(hasattr(telegram, name), name)
        for name in ('listener_run', 'install_tdlib', 'socket_request', 'write_operation'):
            self.assertFalse(hasattr(telegram, name), name)
        commands = next(a for a in telegram.parser()._actions if isinstance(a, argparse._SubParsersAction)).choices
        self.assertEqual(set(commands), {'login', 'auth-status'})

    def test_base_relies_on_native_database_lock(self):
        import inspect
        self.assertFalse(hasattr(telegram, 'ExclusiveLock'))
        self.assertFalse(hasattr(telegram, 'fcntl'))
        self.assertNotIn('lock_timeout', inspect.signature(telegram.session).parameters)
        paths = telegram.runtime_paths('personal')
        self.assertFalse(hasattr(paths, 'lock'))
        self.assertFalse(hasattr(paths, 'run'))

class AccountTests(unittest.TestCase):
    def test_account_names_are_safe_and_paths_are_isolated(self):
        self.assertEqual(telegram.validate_account("personal"), "personal")
        self.assertEqual(telegram.validate_account("alerts_bot"), "alerts_bot")
        for value in ("../work", "a/b", "", ".", "space name", "FOO", "with-dash"):
            with self.assertRaises(telegram.TelegramError):
                telegram.validate_account(value)
        personal = telegram.runtime_paths("personal")
        bot = telegram.runtime_paths("alerts_bot")
        self.assertNotEqual(personal.root, bot.root)
        self.assertEqual(personal.root.name, "personal")
        self.assertEqual(bot.root.name, "alerts_bot")







    def test_error_redaction_masks_env_secrets(self):
        values = {
            "TDLIB_API_HASH": "secret-hash",
            "TDLIB_BOT_TOKEN": "123:secret-token",
            "TDLIB_DATABASE_KEY": "database-secret",
            "CACHE_KEY": "1",
            "UNRELATED_TOKEN": "unrelated-secret-token",
            "TDLIB_SHORT_KEY": "12345",
        }
        text = telegram.redact_secret_values(
            "bad 1 123:secret-token secret-hash database-secret unrelated-secret-token 12345", values
        )
        self.assertEqual(text, "bad 1 [REDACTED] [REDACTED] [REDACTED] unrelated-secret-token 12345")

    def test_error_redaction_uses_tdlib_env_and_resolved_secrets_only(self):
        import os
        env = {
            "CACHE_KEY": "1",
            "OTHER_TOKEN": "unrelated-other-token",
            "TDLIB_API_HASH": "live-tdlib-hash",
        }
        with patch.dict(os.environ, env, clear=True), patch.dict(telegram._resolved_secrets, {"cached-db-secret": "cached-db-secret"}, clear=True):
            text = telegram.redact_secret_values(
                "code 1 live-tdlib-hash cached-db-secret unrelated-other-token"
            )
        self.assertEqual(text, "code 1 [REDACTED] [REDACTED] unrelated-other-token")

    def test_identity_verification_uses_stable_user_id_and_bot_type(self):
        user = {
            "id": 42,
            "first_name": "Alert",
            "last_name": "Bot",
            "usernames": {"active_usernames": ["alerts_bot"]},
            "type": {"@type": "userTypeBot"},
        }
        identity = telegram.telegram_identity(user)
        self.assertEqual(identity["user_id"], 42)
        self.assertTrue(identity["is_bot"])
        verified = telegram.verify_telegram_identity(
            {"expected_user_id": 42, "expected_is_bot": True}, identity
        )
        self.assertTrue(verified["identity_verified"])
        with self.assertRaisesRegex(telegram.TelegramError, "identity mismatch"):
            telegram.verify_telegram_identity(
                {"expected_user_id": 99, "expected_is_bot": True}, identity
            )

class AuthorizationTests(unittest.TestCase):
    def test_single_client_without_pending_mode_or_login_helper(self):
        import inspect
        self.assertFalse(hasattr(telegram, 'TDJson'))
        self.assertFalse(hasattr(telegram, 'login_request'))
        self.assertNotIn('allow_pending', inspect.signature(telegram.Client.authorize).parameters)

    def test_bot_login_uses_supplied_token_without_prompt(self):
        td = make_client(telegram)
        with patch.object(td, 'request', side_effect=[{'@type':'authorizationStateWaitPhoneNumber'}, {'@type':'ok'}, {'@type':'authorizationStateReady'}]) as request, patch('builtins.input') as prompt:
            self.assertEqual(td.authorize({'account_type':'bot','bot_token':'rotated-token'}), 'authorizationStateReady')
            self.assertEqual(request.call_args_list[1].args[0], {'@type':'checkAuthenticationBotToken','token':'rotated-token'})
            prompt.assert_not_called()

    def test_user_login_runs_parameters_phone_code_password_ready(self):
        td = make_client(telegram, paths=telegram.runtime_paths('other'))
        creds = {'account_type':'user','api_id':123,'api_hash':'fixture','database_encryption_key':'fixture-key'}
        states = []
        for state in ('WaitTdlibParameters','WaitPhoneNumber','WaitCode','WaitPassword'):
            states.extend([{'@type':'authorizationState'+state}, {'@type':'ok'}])
        states.append({'@type':'authorizationStateReady'})
        with patch.object(td, 'request', side_effect=states) as request, patch('builtins.input', return_value='+000') as phone, patch.object(telegram.getpass, 'getpass', side_effect=['fixture-code','fixture-password']) as secret:
            self.assertEqual(td.authorize(creds, interactive=True), 'authorizationStateReady')
        payloads = [call.args[0] for call in request.call_args_list if call.args[0]['@type'] != 'getAuthorizationState']
        self.assertEqual([v['@type'] for v in payloads], ['setTdlibParameters','setAuthenticationPhoneNumber','checkAuthenticationCode','checkAuthenticationPassword'])
        self.assertEqual(payloads[0]['database_directory'], str(td.paths.db))
        self.assertEqual(payloads[0]['files_directory'], str(td.paths.files))
        self.assertEqual(payloads[1]['phone_number'], '+000')
        self.assertEqual(payloads[2]['code'], 'fixture-code')
        self.assertEqual(payloads[3]['password'], 'fixture-password')
        self.assertFalse(payloads[0]['use_secret_chats'])
        self.assertEqual(phone.call_count, 1)
        self.assertEqual(secret.call_count, 2)

    def test_noninteractive_user_never_prompts_for_authentication(self):
        for state in ('WaitPhoneNumber','WaitCode','WaitPassword'):
            with self.subTest(state=state):
                td = make_client(telegram)
                with patch.object(td, 'request', return_value={'@type':'authorizationState'+state}) as request, patch('builtins.input') as phone, patch.object(telegram.getpass, 'getpass') as secret:
                    with self.assertRaises(telegram.NotAuthorized): td.authorize({'account_type':'user'})
                    request.assert_called_once()
                    phone.assert_not_called()
                    secret.assert_not_called()

    def test_unusable_or_unsupported_state_is_rejected(self):
        for state in ('Closing','Closed','LoggingOut','WaitEmailAddress'):
            with self.subTest(state=state):
                td = make_client(telegram)
                with patch.object(td, 'request', return_value={'@type':'authorizationState'+state}) as request:
                    with self.assertRaises(telegram.NotAuthorized): td.authorize({'account_type':'user'}, interactive=True)
                    request.assert_called_once()

class SessionTests(unittest.TestCase):
    def test_explicit_paths_and_single_credential_snapshot(self):
        base = telegram
        paths = base.runtime_paths('other_account')
        creds = {'account_type': 'user', 'expected_user_id': 42, 'expected_is_bot': False}
        with patch.object(base, 'ensure_dirs') as dirs, patch.object(base, 'load_credentials', return_value=creds) as load, patch.object(base, 'Client') as client:
            client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with base.session('other_account') as td:
                self.assertTrue(td.identity['identity_verified'])
            dirs.assert_called_once_with(paths)
            load.assert_called_once_with(paths)
            client.assert_called_once_with(paths, updates=(), max_updates=10000)
            client.return_value.authorize.assert_called_once_with(creds, interactive=False)
        for name in ('CURRENT_ACCOUNT', 'STATE_ROOT', 'DB_DIR', 'FILES_DIR', 'select_account'):
            self.assertFalse(hasattr(base, name), name)

    def test_context_authenticates_and_closes_on_task_failure(self):
        self.assertTrue(PATH.exists(), 'reusable TDLib session base is missing')
        spec = importlib.util.spec_from_file_location('session_under_test', PATH)
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        events = []

        class Client:
            def __init__(self, paths, **kwargs): events.append('client')
            def authorize(self, creds, interactive=False):
                self.assert_noninteractive = not interactive
                events.append('auth')
                return 'authorizationStateReady'
            def request(self, payload, timeout=60):
                events.append(payload['@type'])
                return {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            def close(self): events.append('close')

        with patch.object(base, 'ensure_dirs', side_effect=lambda paths: events.append('dirs')), \
             patch.object(base, 'Client', Client), \
             patch.object(base, 'load_credentials', return_value={'expected_user_id': 42, 'expected_is_bot': False}):
            with self.assertRaisesRegex(ValueError, 'task failed'):
                with base.session('personal') as td:
                    self.assertTrue(td.identity['identity_verified'])
                    raise ValueError('task failed')
        self.assertEqual(events, ['dirs', 'client', 'auth', 'getMe', 'close'])

class UpdateTests(unittest.TestCase):
    def load_base(self):
        spec = importlib.util.spec_from_file_location('updates_under_test', PATH)
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        return base

    def test_updates_arriving_during_request_are_retained(self):
        base = self.load_base()
        td = make_client(base, updates=('updateChatFolders',))
        events = iter([
            {'@type': 'updateChatFolders', 'chat_folders': [{'id': 7}]},
            {'@type': 'updateNewMessage', 'message': {'text': 'not retained'}},
            {'@type': 'ok', '@extra': 'request-id'},
        ])
        with patch.object(td, 'send'), patch.object(td, 'receive', side_effect=lambda timeout: next(events)), \
             patch.object(base.uuid, 'uuid4') as uid:
            uid.return_value.hex = 'request-id'
            self.assertEqual(td.request({'@type': 'loadChats'})['@type'], 'ok')
        self.assertEqual(td.wait_update('updateChatFolders', timeout=0)['chat_folders'], [{'id': 7}])
        self.assertEqual(td.drain_updates(), [])

    def test_update_overflow_is_explicit_and_close_still_works(self):
        base = self.load_base()
        td = make_client(base, updates=('updateChatFolders',), max_updates=1)
        event = {'@type': 'updateChatFolders', 'chat_folders': []}
        td.handle_update(event)
        with self.assertRaisesRegex(base.TelegramError, 'overflow'):
            td.handle_update(event)
        closed = {'@type': 'updateAuthorizationState', 'authorization_state': {'@type': 'authorizationStateClosed'}}
        with patch.object(td, 'send'), patch.object(td, 'receive', side_effect=[event, {'@type':'ok'}, closed]):
            td.close()
        self.assertTrue(td._closed)

    def test_wait_does_not_consume_other_update_types(self):
        base = self.load_base()
        td = make_client(base, updates=('updateChatFolders', 'updateChatPosition'))
        td.handle_update({'@type': 'updateChatPosition', 'chat_id': 9})
        td.handle_update({'@type': 'updateChatFolders', 'chat_folders': []})
        self.assertEqual(td.wait_update('updateChatFolders', timeout=0)['chat_folders'], [])
        self.assertEqual(td.drain_updates()[0]['chat_id'], 9)
        with self.assertRaisesRegex(base.TelegramError, 'timed out'):
            td.wait_update('updateChatFolders', timeout=0)

class SessionSafetyTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('safety_under_test', PATH)
        self.base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.base)

    def test_nested_session_fails_before_account_switch(self):
        base = self.base
        with patch.object(base, 'ensure_dirs'), patch.object(base, 'Client') as cls, \
             patch.object(base, 'load_credentials', return_value={'expected_user_id': 42, 'expected_is_bot': False}):
            cls.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with base.session('personal'):
                with self.assertRaisesRegex(base.TelegramError, 'one session'):
                    with base.session('other_account'):
                        self.fail('nested session must not open')
                self.assertFalse(hasattr(base, 'CURRENT_ACCOUNT'))
            self.assertEqual(cls.call_count, 1)

    def test_directory_failure_does_not_open_client_and_releases_guard(self):
        base = self.base
        with patch.object(base, 'ensure_dirs', side_effect=OSError('directory denied')), patch.object(base, 'Client') as cls:
            with self.assertRaisesRegex(OSError, 'directory denied'):
                with base.session('other_account'): pass
            cls.assert_not_called()
            self.assertFalse(hasattr(base, 'CURRENT_ACCOUNT'))
            self.assertFalse(base._active_session.locked())

    def test_client_construction_failure_releases_guard(self):
        base = self.base
        with patch.object(base, 'ensure_dirs'), patch.object(base, 'load_credentials', return_value={}), patch.object(base, 'Client', side_effect=OSError('library unavailable')):
            with self.assertRaisesRegex(OSError, 'library unavailable'):
                with base.session('other_account'): pass
            self.assertFalse(hasattr(base, 'CURRENT_ACCOUNT'))
            self.assertFalse(base._active_session.locked())

    def test_native_database_lock_error_closes_client_without_retry(self):
        base = self.base
        with patch.object(base, 'ensure_dirs'), patch.object(base, 'load_credentials', return_value={}), patch.object(base, 'Client') as cls:
            cls.return_value.authorize.side_effect = base.TDLibError(400, 'database is locked')
            with self.assertRaises(base.TDLibError):
                with base.session('personal'): self.fail('busy database yielded')
            cls.assert_called_once()
            cls.return_value.authorize.assert_called_once()
            cls.return_value.close.assert_called_once()
            self.assertFalse(base._active_session.locked())

    def test_identity_mismatch_closes_without_yielding(self):
        base = self.base
        with patch.object(base, 'ensure_dirs'), patch.object(base, 'Client') as cls, \
             patch.object(base, 'load_credentials', return_value={'expected_user_id': 99, 'expected_is_bot': False}):
            cls.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with self.assertRaisesRegex(base.TelegramError, 'identity mismatch'):
                with base.session('personal'): self.fail('wrong identity must not yield')
            cls.return_value.close.assert_called_once()

    def test_missing_identity_is_not_treated_as_verified(self):
        base = self.base
        with patch.object(base, 'ensure_dirs'), patch.object(base, 'Client') as cls, \
             patch.object(base, 'load_credentials', return_value={}):
            cls.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with self.assertRaisesRegex(base.TelegramError, 'identity is missing'):
                with base.session('personal'): self.fail('missing identity must not yield')
            cls.return_value.close.assert_called_once()

    def test_tdlib_error_exposes_code_and_is_not_retried(self):
        base = self.base
        td = make_client(base)
        with patch.object(td, 'send') as send, \
             patch.object(td, 'receive', return_value={'@type': 'error', 'code': 404, 'message': 'Not Found', '@extra': 'request-id'}), \
             patch.object(base.uuid, 'uuid4') as uid:
            uid.return_value.hex = 'request-id'
            with self.assertRaises(base.TelegramError) as caught:
                td.request({'@type': 'loadChats'})
            self.assertEqual(getattr(caught.exception, 'code', None), 404)
            send.assert_called_once()

class LoginCliTests(unittest.TestCase):
    def test_login_requires_terminal_before_opening_client(self):
        import os
        with patch.dict(os.environ, {}, clear=True), patch.object(telegram.sys.stdin, 'isatty', return_value=False), patch.object(telegram, 'Client') as client:
            with self.assertRaisesRegex(telegram.TelegramError, 'interactive terminal'):
                with telegram.session('personal', login=True): pass
            client.assert_not_called()

    def test_headless_bot_login_does_not_require_tty(self):
        import os
        creds = {'account_type': 'bot', 'bot_token': '123:bot-token', 'expected_user_id': 77, 'expected_is_bot': True}
        with patch.dict(os.environ, {'TDLIB_BOT_TOKEN': '123:bot-token'}, clear=True), \
             patch.object(telegram.sys.stdin, 'isatty', return_value=False), \
             patch.object(telegram, 'ensure_dirs'), patch.object(telegram, 'Client') as client, \
             patch.object(telegram, 'persist_telegram_identity') as persist, \
             patch.object(telegram, 'load_credentials', return_value=creds):
            client.return_value.request.return_value = {'id': 77, 'type': {'@type': 'userTypeBot'}}
            with telegram.session('alerts_bot', login=True) as td:
                self.assertTrue(td.identity['identity_verified'])
                self.assertTrue(td.identity['is_bot'])
            self.assertFalse(client.return_value.authorize.call_args.kwargs['interactive'])
            self.assertEqual(persist.call_args.args[1]['user_id'], 77)
            client.return_value.close.assert_called_once()

    def test_explicit_login_records_identity_and_authorizes_interactively(self):
        with patch.object(telegram.sys.stdin, 'isatty', return_value=True), \
             patch.object(telegram, 'ensure_dirs'), patch.object(telegram, 'Client') as client, \
             patch.object(telegram, 'persist_telegram_identity') as persist, \
             patch.object(telegram, 'load_credentials', return_value={'expected_user_id': 42, 'expected_is_bot': False}):
            client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with telegram.session('personal', login=True) as td:
                self.assertTrue(td.identity['identity_verified'])
            self.assertTrue(client.return_value.authorize.call_args.kwargs['interactive'])
            self.assertEqual(persist.call_args.args[1]['user_id'], 42)
            client.return_value.close.assert_called_once()

    def test_normal_session_does_not_persist_identity(self):
        with patch.object(telegram, 'ensure_dirs'), patch.object(telegram, 'Client') as client, \
             patch.object(telegram, 'persist_telegram_identity') as persist, \
             patch.object(telegram, 'load_credentials', return_value={'expected_user_id': 42, 'expected_is_bot': False}):
            client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            with telegram.session('personal'): pass
            self.assertFalse(client.return_value.authorize.call_args.kwargs['interactive'])
            persist.assert_not_called()

    def test_cli_routes_auth_status_and_redacts_failure(self):
        import contextlib
        import io
        with patch.object(telegram, 'session') as session, contextlib.redirect_stdout(io.StringIO()) as out:
            session.return_value.__enter__.return_value.identity = {'user_id': 42, 'identity_verified': True}
            self.assertEqual(telegram.main(['--account', 'personal', 'auth-status']), 0)
            session.assert_called_once_with('personal', login=False)
            self.assertIn('identity_verified', out.getvalue())
        with patch.object(telegram, 'session', side_effect=telegram.TelegramError('private-error')), \
             patch.object(telegram, 'redact_secret_values', return_value='safe-error'), \
             contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(telegram.main(['auth-status']), 2)
            self.assertNotIn('private-error', err.getvalue())
            self.assertIn('safe-error', err.getvalue())


class RegressionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('regression_base', PATH)
        self.base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.base)




    def test_login_validates_pins_and_configured_type_before_recording(self):
        b = self.base
        for creds in ({'account_type': 'user', 'expected_user_id': 99, 'expected_is_bot': False}, {'account_type': 'bot'}):
            with self.subTest(creds=creds), patch.object(b.sys.stdin, 'isatty', return_value=True), \
                 patch.object(b, 'ensure_dirs'), patch.object(b, 'Client') as client, \
                 patch.object(b, 'load_credentials', return_value=creds), patch.object(b, 'persist_telegram_identity') as persist:
                client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
                with self.assertRaises(b.TelegramError):
                    with b.session('personal', login=True): self.fail('wrong account yielded')
                persist.assert_not_called()

    def test_close_failure_retains_client_and_prevents_another_client(self):
        b = self.base
        with patch.object(b, 'ensure_dirs'), patch.object(b, 'Client') as client, \
             patch.object(b, 'load_credentials', return_value={'expected_user_id': 42, 'expected_is_bot': False}):
            client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
            client.return_value.close.side_effect = b.TelegramError('close timed out')
            with self.assertRaisesRegex(b.TelegramError, 'close timed out'):
                with b.session('personal'): pass
            self.assertIs(b._failed_session, client.return_value)
            self.assertTrue(b._active_session.locked())
            with self.assertRaisesRegex(b.TelegramError, 'previous close failed'):
                with b.session('personal'): self.fail('second client yielded')
            self.assertEqual(client.call_count, 1)


    def test_observed_closed_state_makes_close_idempotent(self):
        b = self.base
        client = make_client(b)
        client.handle_update({'@type': 'updateAuthorizationState', 'authorization_state': {'@type': 'authorizationStateClosed'}})
        with patch.object(client, 'send') as send, patch.object(client, 'receive') as receive:
            client.close(timeout=0)
            client.close(timeout=0)
            send.assert_not_called()
            receive.assert_not_called()


class PortableTests(unittest.TestCase):
    def isolated(self, directory, extra=None):
        import os
        env = {'HOME': directory, 'XDG_CONFIG_HOME': str(Path(directory) / 'config'), 'LEGACY_AGENT_HOME': str(Path(directory) / 'legacy-isolation'), 'TDLIB_STATE_DIR': str(Path(directory) / 'state'), 'TDLIB_ROOT': str(Path(directory) / 'lib'),
               'TDLIB_API_ID': '123', 'TDLIB_API_HASH': 'app-secret', 'TDLIB_DATABASE_KEY': 'original-db-key'}
        env.update(extra or {})
        context = patch.dict(os.environ, env, clear=True)
        context.start()
        self.addCleanup(context.stop)
        spec = importlib.util.spec_from_file_location('portable_base', PATH)
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        return base

    def test_agent_neutral_paths_and_environment_only_credentials(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory, {'LEGACY_AGENT_HOME': directory + '/ignored'})
            self.assertEqual(base.BASE_STATE_ROOT, Path(directory) / 'state')
            self.assertEqual(base.LIB_ROOT, Path(directory) / 'lib')
            self.assertFalse(hasattr(base, 'read_env_values'))
            self.assertFalse(hasattr(base, 'configure'))
            creds = base.load_credentials(base.runtime_paths('personal'))
            self.assertEqual(creds['api_id'], 123)
            self.assertEqual(creds['database_encryption_key'], 'original-db-key')
            self.assertEqual(creds['account_type'], 'user')
            self.assertNotIn('expected_user_id', creds)

    def test_missing_environment_does_not_fall_back_to_agent_files(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            legacy = Path(os.environ['LEGACY_AGENT_HOME'])
            legacy.mkdir()
            (legacy / '.env').write_text('TDLIB_API_HASH=must-not-be-read\n')
            del os.environ['TDLIB_API_HASH']
            with self.assertRaisesRegex(base.NotConfigured, 'TDLIB_API_HASH'):
                base.load_credentials(base.runtime_paths('personal'))

    def test_default_paths_are_neutral_and_follow_xdg_data_home(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'HOME': directory, 'XDG_DATA_HOME': directory + '/data'}, clear=True):
            spec = importlib.util.spec_from_file_location('default_paths_base', PATH)
            base = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(base)
            self.assertEqual(base.BASE_STATE_ROOT, Path(directory) / 'data/tdlib')
            self.assertEqual(base.LIB_ROOT, Path(directory) / '.local/lib/tdlib')

    def test_empty_path_env_vars_resolve_under_home_not_cwd(self):
        import tempfile, os
        cwd = Path.cwd().resolve()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            with patch.dict(os.environ, {'HOME': directory, 'TDLIB_STATE_DIR': '', 'XDG_DATA_HOME': '', 'TDLIB_ROOT': ''}, clear=True):
                spec = importlib.util.spec_from_file_location('empty_paths_base', PATH)
                base = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(base)
                self.assertEqual(base.BASE_STATE_ROOT, home / '.local/share/tdlib')
                self.assertEqual(base.LIB_ROOT, home / '.local/lib/tdlib')
                self.assertNotEqual(base.BASE_STATE_ROOT, cwd)
                self.assertNotEqual(base.BASE_STATE_ROOT, cwd / 'tdlib')
                self.assertNotEqual(base.LIB_ROOT, cwd)
            with patch.dict(os.environ, {'HOME': directory, 'TDLIB_STATE_DIR': '', 'XDG_DATA_HOME': directory + '/data', 'TDLIB_ROOT': ''}, clear=True):
                spec = importlib.util.spec_from_file_location('empty_state_with_xdg_base', PATH)
                base = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(base)
                self.assertEqual(base.BASE_STATE_ROOT, home / 'data/tdlib')
                self.assertEqual(base.LIB_ROOT, home / '.local/lib/tdlib')

    def test_identity_rejects_symlink_corruption_and_loose_permissions(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            base.ensure_dirs(base.runtime_paths('personal'))
            path = base.runtime_paths('personal').root / 'identity.json'
            target = Path(directory) / 'target.json'
            target.write_text('{}')
            path.symlink_to(target)
            with self.assertRaises(base.TelegramError): base.load_credentials(base.runtime_paths('personal'))
            path.unlink()
            path.write_text('{"user_id": true, "is_bot": false}')
            path.chmod(0o600)
            with self.assertRaises(base.TelegramError): base.load_credentials(base.runtime_paths('personal'))
            path.write_text('{"user_id": 42, "is_bot": false}')
            path.chmod(0o644)
            with self.assertRaises(base.TelegramError): base.load_credentials(base.runtime_paths('personal'))

    def test_commit_comes_from_library_without_metadata_or_client(self):
        import tempfile, json, os
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            base.LIB_ROOT.mkdir()
            lib = base.LIB_ROOT / 'libtdjson.so'
            lib.touch()
            native = Mock()
            native.td_execute.return_value = json.dumps({'@type': 'optionValueString', 'value': 'a' * 40}).encode()
            with patch.dict(os.environ, {}, clear=True), patch.object(base.ctypes, 'CDLL', return_value=native) as load:
                self.assertEqual(base.installed_tdlib_commit(), 'a' * 40)
            load.assert_called_once_with(str(lib))
            self.assertEqual(json.loads(native.td_execute.call_args.args[0]), {'@type': 'getOption', 'name': 'commit_hash'})
            native.td_create_client_id.assert_not_called()
            self.assertFalse(base.BASE_STATE_ROOT.exists())
            self.assertEqual([p.name for p in base.LIB_ROOT.iterdir()], ['libtdjson.so'])

    def test_invalid_library_commit_fails_without_fallback(self):
        import tempfile, json
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            base.LIB_ROOT.mkdir()
            (base.LIB_ROOT / 'libtdjson.so').touch()
            native = Mock()
            for result in ({'@type': 'optionValueEmpty'}, {'@type': 'optionValueString', 'value': None},
                           {'@type': 'optionValueString', 'value': 'short'},
                           {'@type': 'error', 'value': 'a' * 40}):
                with self.subTest(result=result), patch.object(base.ctypes, 'CDLL', return_value=native):
                    native.td_execute.return_value = json.dumps(result).encode()
                    with self.assertRaises(base.NotConfigured): base.installed_tdlib_commit()
            with patch.object(base.ctypes, 'CDLL', return_value=native):
                native.td_execute.return_value = None
                with self.assertRaises(base.NotConfigured): base.installed_tdlib_commit()

    def test_identity_is_account_local_not_written_to_environment(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            base.ensure_dirs(base.runtime_paths('personal'))
            before = dict(os.environ)
            base.persist_telegram_identity(base.runtime_paths('personal'), {'user_id': 42, 'is_bot': False})
            path = base.runtime_paths('personal').root / 'identity.json'
            self.assertTrue(path.is_file())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(base.load_credentials(base.runtime_paths('personal'))['expected_user_id'], 42)
            self.assertEqual(dict(os.environ), before)
            self.assertNotIn('expected_user_id', base.load_credentials(base.runtime_paths('other')))

    def test_login_reads_back_new_identity_after_writing(self):
        import tempfile, json
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            with patch.object(base.sys.stdin, 'isatty', return_value=True), patch.object(base, 'Client') as client, patch.object(base, 'load_credentials', wraps=base.load_credentials) as load, patch.object(base, 'verify_telegram_identity', wraps=base.verify_telegram_identity) as verify:
                client.return_value.request.return_value = {'id': 42, 'type': {'@type': 'userTypeRegular'}}
                with base.session('personal', login=True) as td:
                    self.assertTrue(td.identity['identity_verified'])
                self.assertEqual(load.call_count, 2)
                self.assertEqual(verify.call_count, 2)
                self.assertNotIn('expected_user_id', verify.call_args_list[0].args[0])
                self.assertEqual(verify.call_args_list[1].args[0]['expected_user_id'], 42)
                self.assertEqual(json.loads((base.runtime_paths('personal').root / 'identity.json').read_text()), {'user_id':42,'is_bot':False})

    def test_login_rejects_mismatched_persisted_readback(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            persist = base.persist_telegram_identity
            with patch.object(base.sys.stdin, 'isatty', return_value=True), patch.object(base, 'Client') as client, patch.object(base, 'persist_telegram_identity', side_effect=lambda paths, identity: persist(paths, {'user_id':99,'is_bot':False})):
                client.return_value.request.return_value = {'id':42,'type':{'@type':'userTypeRegular'}}
                with self.assertRaisesRegex(base.TelegramError, 'identity mismatch'):
                    with base.session('personal', login=True): self.fail('mismatched readback yielded')
                client.return_value.close.assert_called_once()
                self.assertFalse(base._active_session.locked())

    def test_atomic_write_failure_keeps_previous_identity(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            paths = base.runtime_paths('personal')
            base.ensure_dirs(paths)
            base.persist_telegram_identity(paths, {'user_id':42,'is_bot':False})
            path = paths.root / 'identity.json'
            before = path.read_bytes()
            with patch.object(base.os, 'replace', side_effect=OSError('replace failed')):
                with self.assertRaises(OSError): base.persist_telegram_identity(paths, {'user_id':99,'is_bot':False})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(paths.root.glob('.identity.json.*')), [])

    def test_identity_owned_by_another_uid_is_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory)
            paths = base.runtime_paths('personal')
            base.ensure_dirs(paths)
            base.persist_telegram_identity(paths, {'user_id':42,'is_bot':False})
            with patch.object(base.os, 'getuid', return_value=-1):
                with self.assertRaisesRegex(base.TelegramError, 'owned by'):
                    base.load_credentials(paths)

    def test_bot_token_rotation_preserves_identity_without_fingerprint(self):
        import tempfile, os, json
        with tempfile.TemporaryDirectory() as directory:
            base = self.isolated(directory, {'TDLIB_BOT_TOKEN': 'first-bot-token'})
            base.ensure_dirs(base.runtime_paths('personal'))
            path = base.runtime_paths('personal').root / 'identity.json'
            base.atomic_text(path, json.dumps({'user_id': 42, 'is_bot': True}))
            before = path.read_bytes()
            os.environ['TDLIB_BOT_TOKEN'] = 'different-bot-token'
            self.assertEqual(base.load_credentials(base.runtime_paths('personal'))['expected_user_id'], 42)
            self.assertEqual(path.read_bytes(), before)
            base.persist_telegram_identity(base.runtime_paths('personal'), {'user_id': 42, 'is_bot': True})
            self.assertEqual(json.loads(path.read_text()), {'user_id': 42, 'is_bot': True})


if __name__ == '__main__':
    unittest.main()
