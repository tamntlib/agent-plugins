"""Linux: install exact bundled client/test files, never dependencies or credentials."""
import argparse
import contextlib
import fcntl
import os
from pathlib import Path
import secrets
import stat
import sys

FILES = ('teams_session.py', 'test_teams_session.py')


@contextlib.contextmanager
def destination(path):
    """Walk with directory FDs: never follow a destination ancestor symlink."""
    if not path.is_absolute() or '..' in path.parts or path == Path('/'):
        raise ValueError('target must be an absolute non-root path without traversal')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    private_boundary = False
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, mode=0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not private_boundary):
                raise ValueError('unsafe destination ancestor ownership or permissions')
            # A private owned ancestor makes descendant group modes unreachable
            # to other users. Destination itself must still be private.
            private_boundary |= info.st_uid == os.getuid() and not info.st_mode & 0o077
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('target must be owned by current user with mode 0700')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield fd
    finally:
        os.close(fd)


def installed_bytes(fd, name):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('unsafe installed client file')
    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(file_fd, 'rb') as stream:
        actual = os.fstat(stream.fileno())
        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('installed file changed during preflight')
        return stream.read(1024 * 1024 + 1)


def install(target, replace=False):
    sources = {}
    for name in FILES:
        source = Path(__file__).absolute().with_name(name)
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(source_fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('source must be a regular file')
            sources[name] = stream.read(1024 * 1024 + 1)
            if len(sources[name]) > 1024 * 1024:
                raise ValueError('source too large')
    with destination(target) as fd:
        # Preflight all runtime files before publishing any; never inspect keys/sessions.
        existing = {name: installed_bytes(fd, name) for name in FILES}
        for name in FILES:
            if existing[name] not in (None, sources[name]) and not replace:
                raise ValueError('changed client; inspect first, then use --replace-client')
        for name, content in sources.items():
            if existing[name] == content:
                continue
            pending = '.setup-' + secrets.token_hex(16)
            tmp_fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            try:
                with os.fdopen(tmp_fd, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                # Refuse concurrent changes from non-cooperating installers.
                if installed_bytes(fd, name) != existing[name]:
                    raise ValueError('installed client changed during setup')
                os.replace(pending, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(pending, dir_fd=fd)
                except FileNotFoundError:
                    pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=Path(os.environ.get('XDG_DATA_HOME') or str(Path.home() / '.local/share')) / 'microsoft-teams')
    parser.add_argument('--replace-client', action='store_true', help='Explicitly replace differing client/test files only.')
    args = parser.parse_args(argv)
    try:
        install(args.target, args.replace_client)
    except (OSError, ValueError):
        print('setup refused: unsafe path/permissions or differing client; inspect target and --help before retrying', file=sys.stderr)
        return 2
    print('Installed bundled client/test sources only; no dependencies, keys or sessions touched.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
