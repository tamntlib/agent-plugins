"""Space-bound Backlog API helper. Never pass a credential via CLI arguments."""
import argparse
import json
import math
import os
import pathlib
import re
import sys
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class BacklogError(Exception):
    """Safe, non-secret diagnostics only."""


def resolve_target(target):
    if not isinstance(target, str) or not target or re.search(r'[\s\\\x00-\x1f\x7f]', target):
        raise BacklogError('Invalid target; supply a Backlog HTTPS URL or hostname.')
    parsed = urlsplit(target if '://' in target else 'https://' + target)
    if parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None:
        raise BacklogError('Target must be HTTPS without userinfo.')
    host = parsed.hostname or ''
    if parsed.netloc.lower() != host:
        raise BacklogError('Explicit ports and malformed hostnames are not supported.')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.backlog\.com', host):
        raise BacklogError('Target must be exactly <space>.backlog.com.')
    return host, 'BACKLOG_' + host.split('.')[0].upper().replace('-', '_') + '_API_KEY'


def load_credential(host, environ=None):
    env = os.environ if environ is None else environ
    _, name = resolve_target(host)
    key, source = env.get(name), 'environment'
    if not isinstance(key, str) or not key or key != key.strip() or re.search(r'[\x00-\x20\x7f]', key):
        raise BacklogError('Missing, empty, or invalid credential: ' + name)
    return key, source


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def encode_fields(pairs):
    encoded = []
    for name, value in pairs:
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_]+(?:\[\])?', name):
            raise BacklogError('Invalid API field name; use documented parameter names.')
        if name.lower() in {'apikey', 'authorization'}:
            raise BacklogError('Authentication parameters are forbidden; the client supplies the header.')
        values = value if isinstance(value, list) else [value]
        if isinstance(value, list) and not name.endswith('[]'):
            raise BacklogError('Array field names must explicitly end with [].')
        for item in values:
            if item is None or isinstance(item, (dict, list)) or not isinstance(item, (str, int, float, bool)):
                raise BacklogError('Form fields must be scalars or scalar arrays; use an empty string to clear a documented field.')
            if isinstance(item, float) and not math.isfinite(item):
                raise BacklogError('Non-finite numeric fields are forbidden.')
            encoded.append((name, str(item).lower() if isinstance(item, bool) else str(item)))
    return urlencode(encoded)


def redact(value, secret):
    if isinstance(value, str):
        return value.replace(secret, '[REDACTED]')
    if isinstance(value, list):
        return [redact(v, secret) for v in value]
    if isinstance(value, dict):
        return {redact(k, secret): redact(v, secret) for k, v in value.items()}
    return value


class Client:
    def __init__(self, target, environ=None):
        self.host, self.env_name = resolve_target(target)
        self._key, self.source = load_credential(self.host, environ)
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, *, params=(), data=None, write=False, upload_path=None, download_path=None):
        method = method.upper()
        if method not in {'GET', 'POST', 'PATCH', 'PUT', 'DELETE'}:
            raise BacklogError('Unsupported HTTP method.')
        if method != 'GET' and not write:
            raise BacklogError('Non-GET operations require --write and user-authorized scope.')
        if not isinstance(path, str) or not re.fullmatch(r'/(?:[A-Za-z0-9_.~-]+/)*[A-Za-z0-9_.~-]+', path):
            raise BacklogError('Supply only an API-relative path, without query, fragment, or encoding.')
        if any(p in {'.', '..'} for p in path.split('/')) or path == '/api/v2' or path.startswith('/api/v2/'):
            raise BacklogError('Path must be relative to /api/v2, without traversal.')
        if data is not None and (method == 'GET' or not isinstance(data, dict)):
            raise BacklogError('Only write requests accept a JSON object of form fields.')
        if upload_path is not None and (method != 'POST' or path != '/space/attachment' or data is not None or download_path is not None):
            raise BacklogError('Upload requires POST /space/attachment, --write, and no form data or download.')
        if download_path is not None:
            if method != 'GET':
                raise BacklogError('Downloads require GET.')
            destination = pathlib.Path(download_path)
            if destination.exists() or destination.is_symlink():
                raise BacklogError('Download destination already exists; choose a new file.')
        query = encode_fields(params)
        url = 'https://' + self.host + '/api/v2' + path + ('?' + query if query else '')
        headers = {'Backlog-API-Key': self._key, 'Accept': 'application/json', 'User-Agent': 'AgentSkills-Backlog/0.1'}
        body = None
        if data is not None:
            body = encode_fields(data.items()).encode('utf-8')
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        if upload_path is not None:
            file = pathlib.Path(upload_path)
            if any(c in file.name for c in ['"', '\\', '\r', '\n']) or any(ord(c) < 32 for c in file.name):
                raise BacklogError('Unsafe attachment filename.')
            boundary = 'backlog-' + uuid.uuid4().hex
            try:
                content = file.read_bytes()
            except OSError:
                raise BacklogError('Cannot read upload file.') from None
            body = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + file.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n').encode('utf-8') + content + ('\r\n--' + boundary + '--\r\n').encode('ascii')
            headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=30) as response:
                if not 200 <= response.status < 300:
                    raise BacklogError('HTTP ' + str(response.status) + '; redirects are disabled.')
                raw = response.read()
                status = response.status
        except HTTPError as error:
            message = 'HTTP ' + str(error.code) + ' from ' + self.host + '; no retry or credential fallback.'
            if error.code == 429:
                for name in ['Retry-After', 'X-RateLimit-Reset']:
                    value = error.headers.get(name, '') if error.headers else ''
                    if re.fullmatch(r'[0-9]{1,12}', value):
                        message += ' ' + name + '=' + value
            error.close()
            raise BacklogError(message) from None
        except (URLError, TimeoutError, OSError):
            raise BacklogError('Network failure; write outcome may be unknown. Read back before retrying a write.') from None
        if download_path is not None:
            if self._key.encode('utf-8') in raw:
                raise BacklogError('Refusing a download containing the selected credential.')
            try:
                with destination.open('xb') as output:
                    output.write(raw)
            except OSError:
                raise BacklogError('Cannot save download; check destination. A partial file may need removal.') from None
            return {'status': status, 'output': str(destination), 'bytes': len(raw)}
        try:
            decoded = json.loads(raw) if raw else None
        except (ValueError, UnicodeError):
            raise BacklogError('Non-JSON response; do not dump raw response content.') from None
        return {'status': status, 'data': redact(decoded, self._key)}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise BacklogError('Invalid arguments; use --help. Do not pass credentials as arguments.')


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__)
        parser.add_argument('--target', required=True, help='Explicit Backlog hostname or HTTPS resource URL; inferred by the agent from context.')
        commands = parser.add_subparsers(dest='command', required=True)
        commands.add_parser('resolve', help='Offline host-to-variable resolution; no credential read.')
        commands.add_parser('auth', help='Read-only authentication check; no account details printed.')
        api = commands.add_parser('api', help='One API v2 request; JSON input is encoded as form data.')
        api.add_argument('path', help='API-relative path such as /issues/PROJ-123')
        api.add_argument('--method', choices=['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], default='GET')
        api.add_argument('--param', action='append', default=[], help='Query NAME=VALUE; repeat for array fields.')
        api.add_argument('--data-file', help='Local JSON object containing form fields.')
        api.add_argument('--write', action='store_true', help='Explicit write guard; user authorization still required.')
        api.add_argument('--upload-file', help='Multipart file upload; only POST /space/attachment with --write.')
        api.add_argument('--output', help='Save GET response bytes to a new local file; never overwrite.')
        args = parser.parse_args(argv)
        host, name = resolve_target(args.target)
        if args.command == 'resolve':
            result = {'host': host, 'credential_env': name}
        else:
            client = Client(host)
            if args.command == 'auth':
                response = client.request('GET', '/users/myself')
                data = response['data']
                if not isinstance(data, dict) or type(data.get('id')) is not int:
                    raise BacklogError('Authentication response did not contain the expected user identifier.')
                result = {'host': host, 'credential_env': name, 'credential_source': client.source, 'authenticated': True, 'http_status': response['status']}
            else:
                params = []
                for item in args.param:
                    key, sep, value = item.partition('=')
                    if not sep:
                        raise BacklogError('Each --param must have NAME=VALUE form.')
                    params.append((key, value))
                data = None
                if args.data_file:
                    try:
                        data = json.loads(pathlib.Path(args.data_file).read_text(encoding='utf-8'))
                    except (ValueError, OSError):
                        raise BacklogError('Cannot read data-file as a JSON object.') from None
                result = client.request(args.method, args.path, params=params, data=data, write=args.write, upload_path=args.upload_file, download_path=args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except BacklogError as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        print('{"error": "Unexpected local/client failure; details suppressed to protect credentials."}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
