"""Offline tests; never access real credentials or Backlog."""
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

SCRIPT = pathlib.Path(__file__).with_name('backlog_api.py')


def module():
    if not SCRIPT.exists():
        raise AssertionError('Backlog helper not implemented')
    spec = importlib.util.spec_from_file_location('backlog_api', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class RoutingTests(unittest.TestCase):
    def test_context_target_derives_key_dynamically(self):
        api = module()
        for target, expected in [
            ('example-alpha.backlog.com', ('example-alpha.backlog.com', 'BACKLOG_EXAMPLE_ALPHA_API_KEY')),
            ('https://example-beta.backlog.com/view/PROJ-123#comment-1', ('example-beta.backlog.com', 'BACKLOG_EXAMPLE_BETA_API_KEY')),
            ('future-team.backlog.com', ('future-team.backlog.com', 'BACKLOG_FUTURE_TEAM_API_KEY')),
        ]:
            with self.subTest(target=target):
                self.assertEqual(api.resolve_target(target), expected)


class CredentialTests(unittest.TestCase):
    def test_only_target_key_is_selected_from_process_environment(self):
        api = module()
        env = {'BACKLOG_EXAMPLE_ALPHA_API_KEY': 'fixture-alpha',
               'BACKLOG_EXAMPLE_BETA_API_KEY': 'fixture-beta',
               'BACKLOG_FUTURE_TEAM_API_KEY': 'literal-${NOT_EXPANDED}'}
        self.assertEqual(api.load_credential('example-beta.backlog.com', env), ('fixture-beta', 'environment'))
        self.assertEqual(api.load_credential('example-alpha.backlog.com', env), ('fixture-alpha', 'environment'))
        self.assertEqual(api.load_credential('future-team.backlog.com', env), ('literal-${NOT_EXPANDED}', 'environment'))
        for value in ('', ' padded', 'with space', 'line\nbreak', None):
            with self.subTest(value=value), self.assertRaises(api.BacklogError):
                api.load_credential('example-beta.backlog.com', dict(env, BACKLOG_EXAMPLE_BETA_API_KEY=value))
        with self.assertRaisesRegex(api.BacklogError, 'BACKLOG_ABSENT_API_KEY'):
            api.load_credential('absent.backlog.com', env)

    def test_client_never_discovers_config_files(self):
        api = module()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for config in (
                root / '.config' / 'tamntlib-skills' / 'backlog',
                root / '.config' / 'tamntlib-skills' / 'default' / 'backlog',
            ):
                config.mkdir(parents=True, mode=0o700)
                file = config / '.env'
                file.write_text('BACKLOG_EXAMPLE_BETA_API_KEY=synthetic-file-value\n')
                file.chmod(0o600)
            with patch.dict('os.environ', {'HOME': directory, 'XDG_CONFIG_HOME': str(root / '.config')}, clear=True):
                with self.assertRaisesRegex(api.BacklogError, 'BACKLOG_EXAMPLE_BETA_API_KEY'):
                    api.load_credential('example-beta.backlog.com')
                self.assertEqual(api.load_credential('example-beta.backlog.com', {'BACKLOG_EXAMPLE_BETA_API_KEY': 'synthetic-supplied'}), ('synthetic-supplied', 'environment'))

    def test_unsafe_hosts_are_rejected(self):
        api = module()
        for target in ['http://example-beta.backlog.com', 'https://user@example-beta.backlog.com', 'example-beta.backlog.com:443', 'example-beta.backlog.com.evil.test', 'backlog.com', 'a.b.backlog.com', 'example-beta.backlog.com.', 'example-beta.backlog.jp', 'example-beta.backlog.com\\@evil.test', ' example-beta.backlog.com', 'bad_name.backlog.com']:
            with self.subTest(target=target), self.assertRaises(api.BacklogError):
                api.resolve_target(target)


class FakeResponse(io.BytesIO):
    status = 200
    headers = {'Content-Type': 'application/json'}


class TransportTests(unittest.TestCase):
    def client(self):
        api = module()
        self.assertTrue(hasattr(api, 'Client'), 'HTTP client not implemented')
        return api, api.Client('example-beta.backlog.com', {'BACKLOG_EXAMPLE_BETA_API_KEY': 'fixture-key'})

    def test_get_binds_credential_header_not_query(self):
        api, client = self.client()
        with patch.object(client.opener, 'open', return_value=FakeResponse(b'{"id":123}')) as opened:
            result = client.request('GET', '/issues/PROJ-123', params=[('count', '100')])
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, 'https://example-beta.backlog.com/api/v2/issues/PROJ-123?count=100')
        self.assertEqual(dict((k.lower(), v) for k, v in request.header_items())['backlog-api-key'], 'fixture-key')
        self.assertNotIn('fixture-key', request.full_url)
        self.assertEqual(result['data'], {'id': 123})

    def test_patch_requires_write_and_encodes_form(self):
        api, client = self.client()
        with patch.object(client.opener, 'open', return_value=FakeResponse(b'{"id":123}')) as opened:
            with self.assertRaises(api.BacklogError):
                client.request('PATCH', '/issues/PROJ-123', data={'summary': 'new'})
            opened.assert_not_called()
            client.request('PATCH', '/issues/PROJ-123', write=True, data={'summary': '日本語 & test', 'categoryId[]': [1, 2], 'assigneeId': ''})
        request = opened.call_args.args[0]
        self.assertEqual(request.method, 'PATCH')
        self.assertEqual(parse_qs(request.data.decode(), keep_blank_values=True), {'summary': ['日本語 & test'], 'categoryId[]': ['1', '2'], 'assigneeId': ['']})
        self.assertEqual(request.get_header('Content-type'), 'application/x-www-form-urlencoded')

    def test_path_and_parameter_injection_is_rejected_before_network(self):
        api, client = self.client()
        with patch.object(client.opener, 'open') as opened:
            for path in ['https://evil.test/', '//evil.test', '/../users', '/issues?apiKey=x', '/%2e%2e/users', '/api/v2/issues']:
                with self.subTest(path=path), self.assertRaises(api.BacklogError):
                    client.request('GET', path)
            for params in [[('apiKey', 'value')], [('Backlog-API-Key', 'value')]]:
                with self.assertRaises(api.BacklogError):
                    client.request('GET', '/issues', params=params)
            opened.assert_not_called()

    def test_http_errors_do_not_leak_or_retry(self):
        api, client = self.client()
        for status in [302, 401, 403, 404, 429, 500]:
            error = HTTPError('https://example-beta.backlog.com/?apiKey=fixture-key', status, 'fixture-key', {'X-RateLimit-Reset': '12345'}, io.BytesIO(b'fixture-key'))
            with patch.object(client.opener, 'open', side_effect=error) as opened:
                with self.assertRaises(api.BacklogError) as caught:
                    client.request('GET', '/users/myself')
                self.assertIn(str(status), str(caught.exception))
                self.assertNotIn('fixture-key', str(caught.exception))
                self.assertEqual(opened.call_count, 1)
        with patch.object(client.opener, 'open', side_effect=URLError('fixture-key')):
            with self.assertRaises(api.BacklogError) as caught:
                client.request('POST', '/issues', write=True, data={'summary': 'new'})
            self.assertNotIn('fixture-key', str(caught.exception))
            self.assertIn('unknown', str(caught.exception).lower())

    def test_redirect_handler_never_creates_followup_request(self):
        api, client = self.client()
        handler = next(h for h in client.opener.handlers if isinstance(h, api.NoRedirect))
        self.assertIsNone(handler.redirect_request(None, None, 302, 'redirect', {}, 'https://evil.test'))

    def test_response_echo_of_key_is_redacted(self):
        api, client = self.client()
        body = json.dumps({'content': 'prefix fixture-key suffix', 'nested': ['fixture-key']}).encode()
        with patch.object(client.opener, 'open', return_value=FakeResponse(body)):
            result = client.request('GET', '/issues/PROJ-123')
        self.assertNotIn('fixture-key', json.dumps(result))
        self.assertEqual(result['data']['nested'], ['[REDACTED]'])


class CLITests(unittest.TestCase):
    def test_resolve_is_offline_and_auth_hides_account_details(self):
        api = module()
        self.assertTrue(hasattr(api, 'main'), 'CLI not implemented')
        with patch.object(api, 'load_credential', side_effect=AssertionError('must not load')), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(api.main(['--target', 'future-team.backlog.com', 'resolve']), 0)
        self.assertEqual(json.loads(out.getvalue())['credential_env'], 'BACKLOG_FUTURE_TEAM_API_KEY')
        with patch.object(api, 'load_credential', return_value=('fixture-key', 'environment')), patch.object(api.Client, 'request', return_value={'status': 200, 'data': {'id': 123, 'mailAddress': 'private@example.test', 'name': 'private name'}}), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(api.main(['--target', 'example-beta.backlog.com', 'auth']), 0)
        result = json.loads(out.getvalue())
        self.assertTrue(result['authenticated'])
        self.assertNotIn('private', out.getvalue())
        self.assertNotIn('fixture-key', out.getvalue())

    def test_cli_api_file_payload_and_sanitized_failures(self):
        api = module()
        self.assertTrue(hasattr(api, 'main'), 'CLI not implemented')
        with tempfile.TemporaryDirectory() as directory:
            payload = pathlib.Path(directory) / 'payload.json'
            payload.write_text(json.dumps({'summary': 'new title'}))
            with patch.object(api, 'load_credential', return_value=('fixture-key', 'environment')), patch.object(api.Client, 'request', return_value={'status': 200, 'data': {'id': 123}}) as request, patch('sys.stdout', new_callable=io.StringIO) as out:
                self.assertEqual(api.main(['--target', 'example-beta.backlog.com', 'api', '/issues/PROJ-123', '--method', 'PATCH', '--write', '--data-file', str(payload)]), 0)
            self.assertEqual(request.call_args.kwargs['data'], {'summary': 'new title'})
            self.assertTrue(request.call_args.kwargs['write'])
        with patch.object(api, 'load_credential', side_effect=RuntimeError('fixture-key')), patch('sys.stderr', new_callable=io.StringIO) as err:
            self.assertEqual(api.main(['--target', 'example-beta.backlog.com', 'auth']), 1)
        self.assertNotIn('fixture-key', err.getvalue())
        self.assertNotIn('Traceback', err.getvalue())


class FileTests(unittest.TestCase):
    def test_upload_uses_multipart_and_requires_explicit_endpoint(self):
        api = module()
        import inspect
        self.assertIn('upload_path', inspect.signature(api.Client.request).parameters, 'File upload not implemented')
        client = api.Client('example-beta.backlog.com', {'BACKLOG_EXAMPLE_BETA_API_KEY': 'fixture-key'})
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'notes.txt'
            path.write_bytes(b'file contents')
            with patch.object(client.opener, 'open', return_value=FakeResponse(b'{"id":99}')) as opened:
                result = client.request('POST', '/space/attachment', write=True, upload_path=path)
            request = opened.call_args.args[0]
            self.assertIn('multipart/form-data; boundary=', request.get_header('Content-type'))
            self.assertIn(b'name="file"; filename="notes.txt"', request.data)
            self.assertIn(b'file contents', request.data)
            self.assertEqual(result['data']['id'], 99)
            with patch.object(client.opener, 'open') as opened:
                with self.assertRaises(api.BacklogError):
                    client.request('POST', '/issues', write=True, upload_path=path)
                opened.assert_not_called()

    def test_download_preserves_binary_and_never_overwrites(self):
        api = module()
        import inspect
        self.assertIn('download_path', inspect.signature(api.Client.request).parameters, 'File download not implemented')
        client = api.Client('example-beta.backlog.com', {'BACKLOG_EXAMPLE_BETA_API_KEY': 'fixture-key'})
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'attachment.bin'
            raw = bytes([0, 255, 10, 65])
            with patch.object(client.opener, 'open', return_value=FakeResponse(raw)):
                result = client.request('GET', '/issues/PROJ-123/attachments/99', download_path=output)
            self.assertEqual(output.read_bytes(), raw)
            self.assertEqual(result['bytes'], len(raw))
            with patch.object(client.opener, 'open') as opened:
                with self.assertRaises(api.BacklogError):
                    client.request('GET', '/issues/PROJ-123/attachments/99', download_path=output)
                opened.assert_not_called()
            rejected = pathlib.Path(directory) / 'rejected.bin'
            with patch.object(client.opener, 'open', return_value=FakeResponse(b'fixture-key')):
                with self.assertRaises(api.BacklogError):
                    client.request('GET', '/issues/PROJ-123/attachments/99', download_path=rejected)
            self.assertFalse(rejected.exists())


if __name__ == '__main__':
    unittest.main()
