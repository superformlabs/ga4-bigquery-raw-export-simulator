"""Nothing here names a repository the app does not use.

The generator's code is in this repository now (decision D-91). Two earlier
homes of it must not send a reader or a script elsewhere: the one it left at
decision D-21, and the one the app copied the code from at D-91 and neither
reads nor writes any more. No file of this package may name either of them,
`ORIGIN.md` included: that second repository is private and this package is
public (D-88, D-91). `ORIGIN.md` still has to say where the code came from,
so it gives the date and the commit and names no repository, and the last
test here keeps that promise honest.

Neither name is written out below. They are put together at run time, so
this file does not hold what it refuses, and its own check passes on itself.
"""

from __future__ import annotations

import os
from pathlib import Path

from conftest import PACKAGE_DIR

# Put together at run time, so this file does not contain the names itself.
OLD_REPOSITORY_NAME = "-".join(["synthetic", "ga4", "export"])
PREVIOUS_REPOSITORY_NAME = "-".join(["ga4dataform", "demo", "public"])

# The provenance note. It says the code was copied from a commit of an
# earlier private repository, and names no repository (D-91).
PROVENANCE_FILE = "ORIGIN.md"

# Every commit the code has been brought up to: the first copy (D-91) and
# each sync since. The note has to name all of them, so the check above
# cannot pass by saying nothing at all.
COMMITS = (
    "99028e8ffe4a804220bc9832245b6cc1ee87918f",  # the first copy, 2026-10-13 (D-91)
    "c2e6cf92b1e66b7e2e364836946c555d63c84638",  # the sync of 2026-10-14 (D-95)
)

# Folders that are not part of the repository: git ignores all of them.
NOT_OURS = {".venv", "__pycache__", ".pytest_cache", "out", "build", "dist"}


def files_of_the_package() -> list[Path]:
    found = []
    for folder, folders, names in os.walk(PACKAGE_DIR):
        folders[:] = [
            name for name in folders
            if name not in NOT_OURS and not name.endswith(".egg-info")
        ]
        found += [Path(folder) / name for name in names]
    return found


def mentions_of(name: str, allowed: set[str]) -> list[str]:
    files = files_of_the_package()
    assert files, "no file found to check"
    needle = name.encode()
    return sorted(
        str(path.relative_to(PACKAGE_DIR))
        for path in files
        if str(path.relative_to(PACKAGE_DIR)) not in allowed
        and needle in path.read_bytes()
    )


def test_the_repository_before_d21_appears_nowhere() -> None:
    found = mentions_of(OLD_REPOSITORY_NAME, allowed=set())
    assert not found, f"a repository the app never used is still named in {found}"


def test_the_repository_before_d91_appears_nowhere() -> None:
    found = mentions_of(PREVIOUS_REPOSITORY_NAME, allowed=set())
    assert not found, (
        f"the repository the generator was copied from is named in {found}. "
        f"It is private and this package is public, so no file here names "
        f"it, {PROVENANCE_FILE} included (D-91)."
    )


def test_the_provenance_note_says_where_the_code_came_from() -> None:
    """Otherwise the test above would pass by saying nothing at all."""
    note = (PACKAGE_DIR / PROVENANCE_FILE).read_text(encoding="utf-8")
    missing = [commit for commit in COMMITS if commit not in note]
    assert not missing, f"{PROVENANCE_FILE} does not name {missing}"
