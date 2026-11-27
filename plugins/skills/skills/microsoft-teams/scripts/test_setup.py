"""Offline installer tests; all destinations are synthetic temporary directories."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
FILES = ('teams_session.py', 'test_teams_session.py')


def source(name):
    return SCRIPTS / name


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'data' / 'microsoft-teams'
        self.env = {'HOME': str(self.root), 'XDG_DATA_HOME': str(self.root / 'data'),
                    'TEAMS_CONTEXT': str(self.root / 'context'), 'TMPDIR': str(self.root)}

    def run_setup(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / 'setup.py'), *args],
                              env=self.env, cwd=self.root, capture_output=True, text=True, timeout=10)

    def test_fresh_install_copies_exact_files_only_and_is_idempotent(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.target.iterdir()), sorted(FILES))
        for name in FILES:
            self.assertEqual((self.target / name).read_bytes(), source(name).read_bytes())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.run_setup().returncode, 0)

    def test_changed_client_requires_explicit_replace_and_preserves_state(self):
        self.target.mkdir(parents=True, mode=0o700)
        # Synthetic canaries only, never read any actual credential store.
        for name in ('keys', 'sessions'):
            (self.target / name).mkdir()
            (self.target / name / 'canary').write_bytes(b'synthetic-state')
        (self.target / FILES[1]).write_bytes(b'locally changed tests')
        (self.target / FILES[1]).chmod(0o600)
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target / FILES[0]).exists(), 'preflight must precede all copies')
        self.assertEqual((self.target / FILES[1]).read_bytes(), b'locally changed tests')
        result = self.run_setup('--replace-client')
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in FILES:
            self.assertEqual((self.target / name).read_bytes(), source(name).read_bytes())
        for name in ('keys', 'sessions'):
            self.assertEqual((self.target / name / 'canary').read_bytes(), b'synthetic-state')

    def test_rejects_symlinks_and_unsafe_destinations_even_with_replace(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        sentinel = outside / 'sentinel'
        sentinel.write_bytes(b'unchanged')
        cases = ('target-link', 'parent-link', 'client-link', 'dangling-link',
                 'hardlink', 'directory-file', 'public-target', 'relative-target')
        for case in cases:
            with self.subTest(case=case):
                base = self.root / case
                base.mkdir(mode=0o700)
                target = base / 'install'
                if case == 'target-link':
                    target.symlink_to(outside, target_is_directory=True)
                elif case == 'parent-link':
                    (base / 'alias').symlink_to(outside, target_is_directory=True)
                    target = base / 'alias' / 'install'
                elif case == 'relative-target':
                    target = Path('relative-install')
                else:
                    target.mkdir(mode=0o700)
                    file = target / FILES[0]
                    if case == 'client-link': file.symlink_to(sentinel)
                    elif case == 'dangling-link': file.symlink_to(outside / 'missing')
                    elif case == 'hardlink': os.link(sentinel, file)
                    elif case == 'directory-file': file.mkdir()
                    elif case == 'public-target': target.chmod(0o755)
                result = self.run_setup('--target', str(target), '--replace-client')
                self.assertNotEqual(result.returncode, 0, case)
                self.assertEqual(sentinel.read_bytes(), b'unchanged')
                self.assertFalse((outside / FILES[0]).exists())
                self.assertFalse((outside / 'install').exists())

    def test_empty_xdg_data_home_falls_back_to_home_not_cwd(self):
        workdir = self.root / 'workdir'
        workdir.mkdir(mode=0o700)
        env = dict(self.env, XDG_DATA_HOME='')
        result = subprocess.run([sys.executable, str(SCRIPTS / 'setup.py')],
                                env=env, cwd=workdir, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = self.root / '.local' / 'share' / 'microsoft-teams'
        self.assertTrue(expected.is_dir())
        self.assertEqual(sorted(p.name for p in expected.iterdir()), sorted(FILES))
        self.assertFalse((workdir / 'microsoft-teams').exists())


if __name__ == '__main__':
    unittest.main()
