#!/bin/bash
# release/scripts/render-bundle.sh — 安全暂存固定版本的 Pandoc 与 Typst。
#
# prebuilt：公开四平台 CI 使用固定官方归档。
# source：仅供 package-local 在原生 macOS 上从固定源码构建 Typst。

set -euo pipefail
umask 077
IFS=$' \t\n'
unset BASH_ENV CDPATH ENV GLOBIGNORE

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  return 1
}

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
case "$SCRIPT_SOURCE" in
  /*) ;;
  *) SCRIPT_SOURCE="$PWD/$SCRIPT_SOURCE" ;;
esac
SCRIPT_PARENT="${SCRIPT_SOURCE%/*}"
SCRIPT_DIR="$(cd "$SCRIPT_PARENT" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
VERSIONS_JSON="$SCRIPT_DIR/versions.json"
ARCHITECTURE_MODULE="$REPO_ROOT/scripts/ci/binary-architecture.mjs"
SENSITIVE_SCANNER="$REPO_ROOT/scripts/ci/package-sensitive-boundary.mjs"
DEST_INPUT="${1:-$REPO_ROOT/src-tauri/binaries}"

resolve_fixed_tool() {
  tool_kind="$1"
  case "$tool_kind" in
    env)
      candidates="/usr/bin/env /bin/env /mingw64/bin/env.exe /mingw32/bin/env.exe"
      ;;
    python)
      candidates="/usr/bin/python3 /bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /mingw64/bin/python3.exe /mingw32/bin/python3.exe"
      ;;
    curl)
      candidates="/usr/bin/curl /bin/curl /usr/local/bin/curl /opt/homebrew/bin/curl /mingw64/bin/curl.exe /mingw32/bin/curl.exe /c/Windows/System32/curl.exe"
      ;;
    *)
      fail "fixed render tool selection is invalid."
      return 1
      ;;
  esac
  for candidate in $candidates; do
    if [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if [ "$tool_kind" = "python" ]; then
    for candidate in \
      /usr/bin/python3.[0-9]* \
      /bin/python3.[0-9]* \
      /c/hostedtoolcache/windows/Python/3.14.*/x64/python3.exe \
      /c/hostedtoolcache/windows/Python/3.14.*/x64/python.exe \
      /c/hostedtoolcache/windows/Python/3.13.*/x64/python3.exe \
      /c/hostedtoolcache/windows/Python/3.13.*/x64/python.exe \
      /c/hostedtoolcache/windows/Python/3.12.*/x64/python3.exe \
      /c/hostedtoolcache/windows/Python/3.12.*/x64/python.exe; do
      if [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  fi
  fail "a fixed render tool is unavailable."
  return 1
}

ENV_BIN="$(resolve_fixed_tool env)"
PYTHON_BIN="$(resolve_fixed_tool python)"

python_helper() {
  "$ENV_BIN" -i \
    HOME=/ \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    PYTHONNOUSERSITE=1 \
    SYSTEMROOT='C:\Windows' \
    WINDIR='C:\Windows' \
    "$PYTHON_BIN" - "$@" <<'PY'
import gzip
import hashlib
import io
import json
import lzma
import os
import platform
import posixpath
import re
import shutil
import stat
import struct
import sys
import tempfile
import urllib.parse
import zipfile

SEPARATOR = "\x1f"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_TOOL_BYTES = 1024 * 1024 * 1024
ZERO_BLOCK = b"\0" * 512


class PolicyError(Exception):
    pass


def reject(condition):
    if condition:
        raise PolicyError()


def positive_integer(value, maximum):
    reject(not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum)
    return value


def parse_positive_integer(value, maximum):
    reject(not isinstance(value, str) or not value.isascii() or not value.isdigit())
    return positive_integer(int(value), maximum)


def safe_string(value, maximum=4096):
    reject(not isinstance(value, str) or not value or len(value) > maximum)
    reject(any(ord(character) < 32 or ord(character) == 127 for character in value))
    return value


def safe_sha256(value):
    reject(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None)
    return value


def safe_git_oid(value):
    reject(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None)
    return value


def file_identity(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def secure_file_bytes(path, maximum, expected_size=None, expected_sha256=None):
    reject(not isinstance(path, str) or not os.path.isabs(path) or "\0" in path)
    before_path = os.lstat(path)
    reject(not stat.S_ISREG(before_path.st_mode) or before_path.st_nlink != 1)
    reject(before_path.st_size < 1 or before_path.st_size > maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        reject(file_identity(before_path) != file_identity(before))
        chunks = []
        total = 0
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            reject(total > maximum)
            digest.update(chunk)
            chunks.append(chunk)
        after = os.fstat(descriptor)
        reject(file_identity(before) != file_identity(after))
    finally:
        os.close(descriptor)
    if expected_size is not None:
        reject(total != expected_size)
    if expected_sha256 is not None:
        reject(digest.hexdigest() != expected_sha256)
    return b"".join(chunks)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        reject(key in result)
        result[key] = value
    return result


def load_manifest(path):
    data = secure_file_bytes(path, MAX_MANIFEST_BYTES)
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=strict_object)
    except Exception as error:
        raise PolicyError() from error
    reject(not isinstance(value, dict))
    return value


def validate_url(value, allowed_host):
    value = safe_string(value)
    parsed = urllib.parse.urlsplit(value)
    reject(
        parsed.scheme != "https"
        or parsed.hostname != allowed_host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    )
    return value


def normalize_member(name, directory=False):
    name = safe_string(name)
    reject("\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name) is not None)
    normalized = name[:-1] if directory and name.endswith("/") else name
    parts = normalized.split("/")
    reject(not normalized or any(part in ("", ".", "..") for part in parts))
    return normalized


def platform_manifest(path, engine, target):
    manifest = load_manifest(path)
    reject(engine not in ("pandoc", "typst"))
    engine_value = manifest.get(engine)
    reject(not isinstance(engine_value, dict))
    version = safe_string(engine_value.get("version"), 64)
    platforms = engine_value.get("platforms")
    reject(not isinstance(platforms, dict) or target not in platforms)
    value = platforms[target]
    reject(not isinstance(value, dict))
    url = validate_url(value.get("url"), "github.com")
    archive_format = value.get("archive_format")
    reject(archive_format not in ("tar.gz", "tar.xz", "zip"))
    suffix = {"tar.gz": (".tar.gz", ".tgz"), "tar.xz": (".tar.xz",), "zip": (".zip",)}
    reject(not url.endswith(suffix[archive_format]))
    fields = [
        version,
        url,
        safe_sha256(value.get("sha256")),
        archive_format,
        str(positive_integer(value.get("archive_bytes"), 512 * 1024 * 1024)),
        normalize_member(value.get("archive_member")),
        str(positive_integer(value.get("archive_max_entries"), 4096)),
        str(positive_integer(value.get("expanded_bytes_max"), 2 * 1024 * 1024 * 1024)),
        str(positive_integer(value.get("binary_bytes"), 1024 * 1024 * 1024)),
    ]
    sys.stdout.write(SEPARATOR.join(fields) + "\n")


def source_manifest(path):
    manifest = load_manifest(path)
    typst = manifest.get("typst")
    reject(not isinstance(typst, dict))
    value = typst.get("source_build")
    reject(not isinstance(value, dict) or value.get("cargo_locked") is not True)
    crate = safe_string(value.get("crate"), 128)
    requirement = safe_string(value.get("version_requirement"), 64)
    reject(re.fullmatch(r"=[0-9]+\.[0-9]+\.[0-9]+", requirement) is None)
    root = normalize_member(value.get("crate_root"))
    reject(root != f"{crate}-{requirement[1:]}")
    fields = [
        crate,
        requirement,
        "true",
        validate_url(value.get("crate_url"), "static.crates.io"),
        safe_sha256(value.get("crate_sha256")),
        str(positive_integer(value.get("crate_bytes"), 64 * 1024 * 1024)),
        root,
        str(positive_integer(value.get("archive_max_entries"), 4096)),
        str(positive_integer(value.get("expanded_bytes_max"), 256 * 1024 * 1024)),
        safe_sha256(value.get("cargo_lock_sha256")),
        safe_string(value.get("cargo_version"), 64),
        safe_git_oid(value.get("cargo_commit")),
        safe_string(value.get("rustc_version"), 64),
        safe_git_oid(value.get("rustc_commit")),
        str(positive_integer(value.get("source_date_epoch"), 4_102_444_800)),
    ]
    sys.stdout.write(SEPARATOR.join(fields) + "\n")


def decode_tar_text(field):
    nul = field.find(b"\0")
    if nul >= 0:
        reject(any(field[nul + 1 :]))
        field = field[:nul]
    try:
        return field.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PolicyError() from error


def tar_number(field):
    reject(field[:1] and field[0] & 0x80 != 0)
    text = field.strip(b" \0")
    reject(not text or any(value < 48 or value > 55 for value in text))
    return int(text, 8)


def open_tar_stream(data, archive_format):
    source = io.BytesIO(data)
    if archive_format == "tar.gz":
        return gzip.GzipFile(fileobj=source, mode="rb")
    if archive_format == "tar.xz":
        return lzma.LZMAFile(source, mode="rb")
    raise PolicyError()


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(min(1024 * 1024, remaining))
        reject(not chunk)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def scan_tar(data, archive_format, maximum_entries, maximum_expanded, handler=None):
    entries = []
    seen = set()
    expanded = 0
    stream = open_tar_stream(data, archive_format)
    try:
        while True:
            header = read_exact(stream, 512)
            if header == ZERO_BLOCK:
                reject(read_exact(stream, 512) != ZERO_BLOCK)
                trailing = stream.read(maximum_entries * 512 + 1)
                reject(any(trailing) or len(trailing) > maximum_entries * 512)
                break
            stored_checksum = tar_number(header[148:156])
            calculated_checksum = sum(header[:148]) + 8 * 32 + sum(header[156:])
            reject(stored_checksum != calculated_checksum)
            name = decode_tar_text(header[:100])
            prefix = decode_tar_text(header[345:500])
            if prefix:
                name = f"{prefix}/{name}"
            type_flag = header[156:157]
            reject(type_flag not in (b"\0", b"0", b"1", b"2", b"5"))
            directory = type_flag == b"5"
            kind = "directory" if directory else "regular"
            link_target = ""
            if type_flag in (b"1", b"2"):
                kind = "hardlink" if type_flag == b"1" else "symlink"
                link_target = decode_tar_text(header[157:257])
            name = normalize_member(name, directory=directory)
            reject(name in seen)
            seen.add(name)
            size = tar_number(header[124:136])
            reject(kind != "regular" and size != 0)
            entries.append(
                {
                    "name": name,
                    "size": size,
                    "directory": directory,
                    "kind": kind,
                    "link_target": link_target,
                }
            )
            reject(len(entries) > maximum_entries)
            if kind == "regular":
                expanded += size
                reject(expanded > maximum_expanded)
            descriptor = handler(name, size, directory) if handler is not None and kind in ("regular", "directory") else None
            remaining = size
            try:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    reject(not chunk)
                    if descriptor is not None:
                        os.write(descriptor, chunk)
                    remaining -= len(chunk)
                if descriptor is not None:
                    os.fsync(descriptor)
            finally:
                if descriptor is not None:
                    os.close(descriptor)
            padding = (512 - (size % 512)) % 512
            if padding:
                reject(any(read_exact(stream, padding)))
    except (OSError, EOFError, gzip.BadGzipFile, lzma.LZMAError) as error:
        raise PolicyError() from error
    finally:
        stream.close()
    return entries


def zip_entries(data, maximum_entries, maximum_expanded):
    reject(len(data) < 22)
    search_start = max(0, len(data) - 65_557)
    end_offset = data.rfind(b"PK\x05\x06", search_start)
    reject(end_offset < 0 or end_offset + 22 > len(data))
    disk, central_disk, disk_entries, total_entries, central_size, central_offset, comment_size = struct.unpack_from(
        "<HHHHIIH", data, end_offset + 4
    )
    reject(
        disk != 0
        or central_disk != 0
        or disk_entries != total_entries
        or total_entries < 1
        or total_entries > maximum_entries
        or end_offset + 22 + comment_size != len(data)
        or central_offset + central_size != end_offset
    )
    entries = []
    seen = set()
    expanded = 0
    cursor = central_offset
    occupied = []
    for _ in range(total_entries):
        reject(cursor + 46 > end_offset or data[cursor : cursor + 4] != b"PK\x01\x02")
        (
            version_made,
            _,
            flags,
            method,
            _,
            _,
            checksum,
            compressed_size,
            size,
            name_size,
            extra_size,
            entry_comment_size,
            entry_disk,
            _,
            external_attributes,
            local_offset,
        ) = struct.unpack_from("<HHHHHHIIIHHHHHII", data, cursor + 4)
        reject(entry_disk != 0 or flags & 0x0009 or method not in (0, 8))
        name_start = cursor + 46
        name_end = name_start + name_size
        entry_end = name_end + extra_size + entry_comment_size
        reject(entry_end > end_offset)
        raw_name = data[name_start:name_end]
        reject(b"\0" in raw_name)
        try:
            name_text = raw_name.decode("utf-8" if flags & 0x0800 else "cp437")
        except UnicodeDecodeError as error:
            raise PolicyError() from error
        unix_mode = (external_attributes >> 16) & 0xFFFF if version_made >> 8 == 3 else 0
        file_type = stat.S_IFMT(unix_mode)
        directory = name_text.endswith("/")
        kind = "directory" if directory else "regular"
        if file_type:
            reject(file_type not in (stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK))
            if file_type == stat.S_IFLNK:
                reject(directory)
                kind = "symlink"
            else:
                reject((file_type == stat.S_IFDIR) != directory)
        reject(kind == "directory" and size != 0)
        name = normalize_member(name_text, directory=directory)
        reject(name in seen)
        seen.add(name)
        reject(local_offset + 30 > central_offset or data[local_offset : local_offset + 4] != b"PK\x03\x04")
        local_flags, local_method = struct.unpack_from("<HH", data, local_offset + 6)
        local_checksum, local_compressed, local_size = struct.unpack_from("<III", data, local_offset + 14)
        local_name_size, local_extra_size = struct.unpack_from("<HH", data, local_offset + 26)
        local_name_start = local_offset + 30
        local_name_end = local_name_start + local_name_size
        payload_start = local_name_end + local_extra_size
        payload_end = payload_start + compressed_size
        reject(
            local_flags != flags
            or local_method != method
            or local_checksum != checksum
            or local_compressed != compressed_size
            or local_size != size
            or local_name_end > central_offset
            or data[local_name_start:local_name_end] != raw_name
            or payload_end > central_offset
        )
        occupied.append((local_offset, payload_end))
        entries.append({"name": name, "size": size, "directory": directory, "kind": kind})
        if kind in ("regular", "symlink"):
            expanded += size
            reject(expanded > maximum_expanded)
        cursor = entry_end
    reject(cursor != end_offset)
    occupied.sort()
    for index in range(1, len(occupied)):
        reject(occupied[index][0] < occupied[index - 1][1])
    return entries


def scan_archive(data, archive_format, maximum_entries, maximum_expanded, handler=None):
    if archive_format in ("tar.gz", "tar.xz"):
        return scan_tar(data, archive_format, maximum_entries, maximum_expanded, handler)
    if archive_format == "zip":
        reject(handler is not None)
        return zip_entries(data, maximum_entries, maximum_expanded)
    raise PolicyError()


def enforce_executable_member(entries, expected_member, candidate):
    expected_member = normalize_member(expected_member)
    candidate = safe_string(candidate, 128)
    regular = [entry for entry in entries if entry["kind"] == "regular"]
    candidates = [entry for entry in regular if entry["name"].rsplit("/", 1)[-1] == candidate]
    reject(len(candidates) != 1 or candidates[0]["name"] != expected_member)
    return candidates[0]


def normalized_link_destination(link_name, target, hardlink=False):
    target = safe_string(target, 4096)
    reject("\\" in target or target.startswith("/") or re.match(r"^[A-Za-z]:", target) is not None)
    parts = target.split("/")
    reject(any(part in ("", ".", "..") for part in parts))
    if hardlink and "/" in target:
        resolved = posixpath.normpath(target)
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(link_name), target))
    return normalize_member(resolved)


def validate_nonmaterialized_links(data, archive_format, entries, expected_member):
    links = [entry for entry in entries if entry["kind"] in ("symlink", "hardlink")]
    reject(any(entry["kind"] == "hardlink" for entry in links))
    reject(len(links) > 8)
    zip_targets = {}
    if archive_format == "zip" and links:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            for entry in links:
                infos = [value for value in archive.infolist() if value.filename == entry["name"]]
                reject(len(infos) != 1 or infos[0].file_size < 1 or infos[0].file_size > 4096)
                with archive.open(infos[0], "r") as source:
                    raw_target = source.read(4097)
                reject(len(raw_target) > 4096 or b"\0" in raw_target)
                try:
                    zip_targets[entry["name"]] = raw_target.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise PolicyError() from error
    for entry in links:
        target = entry.get("link_target", "") if archive_format != "zip" else zip_targets[entry["name"]]
        resolved = normalized_link_destination(entry["name"], target, entry["kind"] == "hardlink")
        reject(resolved != expected_member)


def open_output(path):
    reject(not os.path.isabs(path) or os.path.lexists(path))
    parent = os.path.dirname(path)
    parent_info = os.lstat(parent)
    reject(not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode))
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o700)


def extract_one(args):
    (
        archive_path,
        archive_format,
        expected_member,
        candidate,
        expected_archive_bytes,
        maximum_member_bytes,
        maximum_entries,
        maximum_expanded,
        expected_sha256,
        output,
        expected_binary_bytes,
    ) = args
    expected_archive_bytes = parse_positive_integer(expected_archive_bytes, 512 * 1024 * 1024)
    maximum_member_bytes = parse_positive_integer(maximum_member_bytes, 1024 * 1024 * 1024)
    maximum_entries = parse_positive_integer(maximum_entries, 4096)
    maximum_expanded = parse_positive_integer(maximum_expanded, 2 * 1024 * 1024 * 1024)
    expected_binary_bytes = parse_positive_integer(expected_binary_bytes, 1024 * 1024 * 1024)
    data = secure_file_bytes(
        archive_path,
        expected_archive_bytes,
        expected_size=expected_archive_bytes,
        expected_sha256=safe_sha256(expected_sha256),
    )
    entries = scan_archive(data, archive_format, maximum_entries, maximum_expanded)
    selected = enforce_executable_member(entries, expected_member, candidate)
    validate_nonmaterialized_links(data, archive_format, entries, expected_member)
    reject(selected["size"] != expected_binary_bytes or selected["size"] > maximum_member_bytes)
    if archive_format == "zip":
        descriptor = open_output(output)
        try:
            with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
                infos = [value for value in archive.infolist() if value.filename == expected_member]
                reject(len(infos) != 1 or infos[0].file_size != expected_binary_bytes)
                total = 0
                with archive.open(infos[0], "r") as source:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        reject(total > expected_binary_bytes)
                        os.write(descriptor, chunk)
                reject(total != expected_binary_bytes)
                os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return

    def handler(name, size, directory):
        if directory or name != expected_member:
            return None
        reject(size != expected_binary_bytes)
        return open_output(output)

    scan_tar(data, archive_format, maximum_entries, maximum_expanded, handler)


def audit_archive(args):
    archive_path, archive_format, expected_member, candidate, maximum_archive, maximum_member, maximum_entries, maximum_expanded = args
    maximum_archive = parse_positive_integer(maximum_archive, 512 * 1024 * 1024)
    maximum_member = parse_positive_integer(maximum_member, 1024 * 1024 * 1024)
    maximum_entries = parse_positive_integer(maximum_entries, 4096)
    maximum_expanded = parse_positive_integer(maximum_expanded, 2 * 1024 * 1024 * 1024)
    data = secure_file_bytes(archive_path, maximum_archive)
    entries = scan_archive(data, archive_format, maximum_entries, maximum_expanded)
    selected = enforce_executable_member(entries, expected_member, candidate)
    validate_nonmaterialized_links(data, archive_format, entries, expected_member)
    reject(selected["size"] > maximum_member)


def safe_destination_root(root, name):
    reject(not os.path.isabs(root) or "\0" in root)
    relative = normalize_member(name)
    destination = os.path.join(root, *relative.split("/"))
    reject(os.path.commonpath((root, destination)) != root)
    return destination


def extract_source_tree(args):
    archive_path, expected_bytes, expected_sha256, root_name, maximum_entries, maximum_expanded, destination = args
    expected_bytes = parse_positive_integer(expected_bytes, 64 * 1024 * 1024)
    maximum_entries = parse_positive_integer(maximum_entries, 4096)
    maximum_expanded = parse_positive_integer(maximum_expanded, 256 * 1024 * 1024)
    root_name = normalize_member(root_name)
    reject(not os.path.isabs(destination) or os.path.lexists(destination))
    os.mkdir(destination, 0o700)
    data = secure_file_bytes(
        archive_path,
        expected_bytes,
        expected_size=expected_bytes,
        expected_sha256=safe_sha256(expected_sha256),
    )
    entries = scan_tar(data, "tar.gz", maximum_entries, maximum_expanded)
    reject(any(entry["kind"] not in ("regular", "directory") for entry in entries))
    reject(not entries or any(entry["name"] != root_name and not entry["name"].startswith(root_name + "/") for entry in entries))

    def handler(name, size, directory):
        output = safe_destination_root(destination, name)
        if directory:
            os.makedirs(output, mode=0o700, exist_ok=False)
            return None
        parent = os.path.dirname(output)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        return open_output(output)

    scan_tar(data, "tar.gz", maximum_entries, maximum_expanded, handler)
    source_root = safe_destination_root(destination, root_name)
    reject(not os.path.isfile(os.path.join(source_root, "Cargo.toml")))
    reject(not os.path.isfile(os.path.join(source_root, "Cargo.lock")))


def verify_file_hash(path, expected):
    secure_file_bytes(path, MAX_TOOL_BYTES, expected_sha256=safe_sha256(expected))


def canonical_tool(path, expected_sha256):
    reject(not isinstance(path, str) or not os.path.isabs(path) or "\0" in path)
    resolved = os.path.realpath(path)
    reject(not os.path.isabs(resolved))
    value = os.stat(resolved)
    reject(not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_mode & 0o111 == 0)
    secure_file_bytes(resolved, MAX_TOOL_BYTES, expected_sha256=safe_sha256(expected_sha256))
    sys.stdout.write(resolved + "\n")


def prepare_destination(destination, source_mode, outputs):
    reject(not isinstance(destination, str) or "\0" in destination)
    destination = os.path.abspath(destination)
    parent = os.path.dirname(destination)
    parent_info = os.lstat(parent)
    reject(not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode))
    if source_mode:
        reject(os.path.lexists(destination))
    elif os.path.lexists(destination):
        destination_info = os.lstat(destination)
        reject(not stat.S_ISDIR(destination_info.st_mode) or stat.S_ISLNK(destination_info.st_mode))
        for output in outputs:
            reject(os.path.lexists(os.path.join(destination, output)))
    work = tempfile.mkdtemp(prefix=".render-stage-", dir=parent)
    for name in ("publish", "downloads", "home", "tmp", "cargo", "cargo-target", "install", "source"):
        os.mkdir(os.path.join(work, name), 0o700)
    sys.stdout.write(SEPARATOR.join((destination, work)) + "\n")


def exact_regular_names(root):
    names = sorted(os.listdir(root))
    for name in names:
        value = os.lstat(os.path.join(root, name))
        reject(not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_nlink != 1)
    return names


def fsync_directory(path):
    # Windows 不支持以只读方式打开目录；文件本身已逐个 fsync，目录持久化由原子重命名保证。
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_outputs(stage, destination, expected, source_mode):
    reject(not os.path.isabs(stage) or not os.path.isabs(destination))
    expected_names = sorted(expected)
    reject(len(expected_names) != 2 or len(set(expected_names)) != 2)
    reject(exact_regular_names(stage) != expected_names)
    for name in expected_names:
        descriptor = os.open(os.path.join(stage, name), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    fsync_directory(stage)
    parent = os.path.dirname(destination)
    if source_mode or not os.path.lexists(destination):
        reject(os.path.lexists(destination))
        os.rename(stage, destination)
        fsync_directory(parent)
        return
    destination_info = os.lstat(destination)
    reject(not stat.S_ISDIR(destination_info.st_mode) or stat.S_ISLNK(destination_info.st_mode))
    for name in expected_names:
        target = os.path.join(destination, name)
        reject(os.path.lexists(target))
    for name in expected_names:
        os.rename(os.path.join(stage, name), os.path.join(destination, name))
    fsync_directory(destination)


def copy_regular(source, destination, maximum):
    maximum = parse_positive_integer(maximum, 1024 * 1024 * 1024)
    data = secure_file_bytes(source, maximum)
    descriptor = open_output(destination)
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset : offset + 1024 * 1024])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def remove_work(path):
    reject(not os.path.isabs(path) or not os.path.basename(path).startswith(".render-stage-"))
    if not os.path.lexists(path):
        return
    value = os.lstat(path)
    reject(not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode))
    shutil.rmtree(path)


def host_target():
    system = platform.system()
    machine = platform.machine().lower()
    if system != "Darwin":
        sys.stdout.write("unsupported\n")
    elif machine in ("arm64", "aarch64"):
        sys.stdout.write("darwin-arm64\n")
    elif machine in ("x86_64", "amd64"):
        sys.stdout.write("darwin-x86_64\n")
    else:
        sys.stdout.write("unsupported\n")


def main():
    reject(len(sys.argv) < 2)
    command = sys.argv[1]
    args = sys.argv[2:]
    if command == "manifest-platform" and len(args) == 3:
        platform_manifest(*args)
    elif command == "manifest-source" and len(args) == 1:
        source_manifest(*args)
    elif command == "audit" and len(args) == 8:
        audit_archive(args)
    elif command == "extract-one" and len(args) == 11:
        extract_one(args)
    elif command == "extract-source" and len(args) == 7:
        extract_source_tree(args)
    elif command == "verify-hash" and len(args) == 2:
        verify_file_hash(*args)
    elif command == "canonical-tool" and len(args) == 2:
        canonical_tool(*args)
    elif command == "prepare-source" and len(args) == 3:
        prepare_destination(args[0], True, args[1:])
    elif command == "prepare-prebuilt" and len(args) == 3:
        prepare_destination(args[0], False, args[1:])
    elif command == "publish-source" and len(args) == 4:
        publish_outputs(args[0], args[1], args[2:], True)
    elif command == "publish-prebuilt" and len(args) == 4:
        publish_outputs(args[0], args[1], args[2:], False)
    elif command == "copy-regular" and len(args) == 3:
        copy_regular(*args)
    elif command == "remove-work" and len(args) == 1:
        remove_work(*args)
    elif command == "host" and not args:
        host_target()
    else:
        raise PolicyError()


try:
    main()
except Exception:
    sys.exit(1)
PY
}

if [ "${1:-}" = "audit-archive" ]; then
  if [ "$#" -ne 9 ]; then
    fail "render archive audit arguments are invalid."
    exit 1
  fi
  if ! python_helper audit "$3" "$2" "$4" "$5" "$6" "$7" "$8" "$9"; then
    fail "render archive policy rejected input."
    exit 1
  fi
  printf 'PASS: render archive policy verified.\n'
  exit 0
fi

case "${RENDER_BUNDLE_MODE:-}" in
  prebuilt) render_mode=prebuilt ;;
  source) render_mode=source ;;
  *)
    printf 'ERROR: RENDER_BUNDLE_MODE must be exactly prebuilt or source.\n' >&2
    exit 1
    ;;
esac

case "${RENDER_BUNDLE_TARGET:-}" in
  darwin-arm64) triple=aarch64-apple-darwin ;;
  darwin-x86_64) triple=x86_64-apple-darwin ;;
  linux-x86_64) triple=x86_64-unknown-linux-gnu ;;
  windows-x86_64) triple=x86_64-pc-windows-msvc ;;
  *)
    fail "RENDER_BUNDLE_TARGET must select one supported public target."
    exit 1
    ;;
esac
target="$RENDER_BUNDLE_TARGET"

external_output_name() {
  name="$1"
  if [ "$target" = "windows-x86_64" ]; then
    printf '%s' "$name-$triple.exe"
  else
    printf '%s' "$name-$triple"
  fi
}

pandoc_output="$(external_output_name pandoc)"
typst_output="$(external_output_name typst)"

if [ "$render_mode" = "source" ]; then
  host_target="$(python_helper host)" || {
    fail "source render-bundle host verification failed."
    exit 1
  }
  if [ "$host_target" = "unsupported" ]; then
    fail "source render-bundle mode requires macOS."
    exit 1
  fi
  if [ "$target" != "$host_target" ]; then
    fail "source render-bundle mode requires the native macOS target."
    exit 1
  fi
fi

if [ "$render_mode" = "source" ]; then
  if ! prepared="$(python_helper prepare-source "$DEST_INPUT" "$pandoc_output" "$typst_output")"; then
    fail "source render destination must be absent."
    exit 1
  fi
else
  if ! prepared="$(python_helper prepare-prebuilt "$DEST_INPUT" "$pandoc_output" "$typst_output")"; then
    fail "prebuilt render destination is invalid."
    exit 1
  fi
fi
old_ifs="$IFS"
IFS=$'\x1f'
read -r DEST_DIR WORK_ROOT <<EOF
$prepared
EOF
IFS="$old_ifs"
STAGE_DIR="$WORK_ROOT/publish"
DOWNLOAD_DIR="$WORK_ROOT/downloads"
PRIVATE_HOME="$WORK_ROOT/home"
PRIVATE_TMP="$WORK_ROOT/tmp"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "${WORK_ROOT:-}" ]; then
    python_helper remove-work "$WORK_ROOT" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

abort() {
  exit 1
}

trap cleanup EXIT
trap abort HUP INT TERM

validate_timeout() {
  value="$1"
  maximum="$2"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le "$maximum" ]
}

if [ "$render_mode" = "source" ]; then
  if [ "${RENDER_BUNDLE_OUTER_RUNNER:-}" != "bounded-process-v1" ] || \
    ! validate_timeout "${RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS:-}" 1200 || \
    ! validate_timeout "${RENDER_BUNDLE_TOTAL_TIMEOUT_SECONDS:-}" 7200 || \
    [ "$RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS" -ge "$RENDER_BUNDLE_TOTAL_TIMEOUT_SECONDS" ]; then
    fail "source render-bundle requires an explicit bounded runner contract."
    exit 1
  fi
  network_timeout="$RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS"
else
  network_timeout=900
fi

CURL_BIN="$(resolve_fixed_tool curl)"

download_file() {
  url="$1"
  output="$2"
  expected_bytes="$3"
  if ! "$ENV_BIN" -i \
    HOME="$PRIVATE_HOME" \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    TMPDIR="$PRIVATE_TMP" \
    SYSTEMROOT='C:\Windows' \
    WINDIR='C:\Windows' \
    "$CURL_BIN" \
      --disable \
      --fail \
      --location \
      --max-filesize "$expected_bytes" \
      --max-redirs 5 \
      --proto '=https' \
      --proto-redir '=https' \
      --silent \
      --show-error \
      --connect-timeout 20 \
      --speed-limit 1024 \
      --speed-time 30 \
      --max-time "$network_timeout" \
      --retry 3 \
      --retry-delay 2 \
      --retry-max-time "$network_timeout" \
      --output "$output" \
      "$url" >"$WORK_ROOT/download.log" 2>&1; then
    fail "render archive download failed."
    return 1
  fi
}

stage_prebuilt_engine() {
  name="$1"
  if ! metadata="$(python_helper manifest-platform "$VERSIONS_JSON" "$name" "$target")"; then
    fail "render version manifest is invalid."
    return 1
  fi
  old_ifs="$IFS"
  IFS=$'\x1f'
  read -r version url expected_sha256 archive_format archive_bytes archive_member archive_max_entries expanded_bytes_max binary_bytes <<EOF
$metadata
EOF
  IFS="$old_ifs"
  archive="$DOWNLOAD_DIR/$name-$version.$archive_format"
  output_name="$(external_output_name "$name")"
  candidate="$name"
  if [ "$target" = "windows-x86_64" ]; then
    candidate="$name.exe"
  fi
  download_file "$url" "$archive" "$archive_bytes"
  if ! python_helper extract-one \
    "$archive" \
    "$archive_format" \
    "$archive_member" \
    "$candidate" \
    "$archive_bytes" \
    "$binary_bytes" \
    "$archive_max_entries" \
    "$expanded_bytes_max" \
    "$expected_sha256" \
    "$STAGE_DIR/$output_name" \
    "$binary_bytes"; then
    fail "render archive verification failed."
    return 1
  fi
}

require_source_tool() {
  path_variable="$1"
  hash_variable="$2"
  path_value="${!path_variable:-}"
  hash_value="${!hash_variable:-}"
  case "$path_value" in
    /*) ;;
    *) fail "source render tool identity is required."; return 1 ;;
  esac
  if ! canonical="$(python_helper canonical-tool "$path_value" "$hash_value")"; then
    fail "source render tool identity is invalid."
    return 1
  fi
  printf '%s' "$canonical"
}

require_version_line() {
  text="$1"
  expected="$2"
  padded_text=$'\n'"$text"$'\n'
  case "$padded_text" in
    *$'\n'"$expected"$'\n'*) return 0 ;;
    *) fail "pinned Rust toolchain verification failed."; return 1 ;;
  esac
}

verify_binary_architecture() {
  binary="$1"
  if ! "$ENV_BIN" -i \
    HOME="$PRIVATE_HOME" \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    "$node_bin" \
      --input-type=module \
      --eval 'import { pathToFileURL } from "node:url"; const [modulePath,binaryPath,target]=process.argv.slice(1); const api=await import(pathToFileURL(modulePath).href); api.assertBinaryArchitectureInfo(await api.readBinaryArchitecture(binaryPath), target);' \
      "$ARCHITECTURE_MODULE" \
      "$binary" \
      "$triple" >"$WORK_ROOT/architecture.log" 2>&1; then
    fail "Typst executable architecture verification failed."
    return 1
  fi
}

scan_typst_binary() {
  built_typst="$1"
  if ! "$ENV_BIN" -i \
    HOME="$PRIVATE_HOME" \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    "$node_bin" "$SENSITIVE_SCANNER" verify-rust-source-root \
      --root "${built_typst%/*}" >"$WORK_ROOT/sensitive-scan.log" 2>&1; then
    fail "Typst executable sensitive-data scan failed."
    return 1
  fi
}

verify_typst_version() {
  built_typst="$1"
  expected_version="$2"
  if ! version_output="$("$ENV_BIN" -i \
    HOME="$PRIVATE_HOME" \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    TMPDIR="$PRIVATE_TMP" \
    "$built_typst" --version 2>"$WORK_ROOT/typst-version.log")"; then
    fail "Typst executable version verification failed."
    return 1
  fi
  if [ "$version_output" != "typst $expected_version (unknown hash)" ]; then
    fail "Typst executable version verification failed."
    return 1
  fi
}

build_typst_from_source() {
  if ! metadata="$(python_helper manifest-source "$VERSIONS_JSON")"; then
    fail "Typst source manifest is invalid."
    return 1
  fi
  old_ifs="$IFS"
  IFS=$'\x1f'
  read -r crate version_requirement locked crate_url crate_sha256 crate_bytes crate_root archive_max_entries expanded_bytes_max cargo_lock_sha256 expected_cargo_version expected_cargo_commit expected_rustc_version expected_rustc_commit source_date_epoch <<EOF
$metadata
EOF
  IFS="$old_ifs"
  if [ "$locked" != "true" ]; then
    fail "Typst source build must use a locked dependency graph."
    return 1
  fi
  version="${version_requirement#=}"

  cargo_bin="$(require_source_tool RENDER_BUNDLE_CARGO RENDER_BUNDLE_CARGO_SHA256)"
  rustc_bin="$(require_source_tool RENDER_BUNDLE_RUSTC RENDER_BUNDLE_RUSTC_SHA256)"
  node_bin="$(require_source_tool RENDER_BUNDLE_NODE RENDER_BUNDLE_NODE_SHA256)"
  source_home="${PACKAGE_LOCAL_SOURCE_HOME:-}"
  rustup_home="${PACKAGE_LOCAL_RUSTUP_HOME:-}"
  case "$source_home" in /*) ;; *) fail "package source home must be absolute."; return 1 ;; esac
  case "$rustup_home" in /*) ;; *) fail "package Rust toolchain home must be absolute."; return 1 ;; esac

  private_cargo_home="$WORK_ROOT/cargo"
  private_target="$WORK_ROOT/cargo-target"
  install_root="$WORK_ROOT/install"
  source_parent="$WORK_ROOT/source"
  source_root="$source_parent/$crate_root"
  source_archive="$DOWNLOAD_DIR/$crate-$version.crate"

  download_file "$crate_url" "$source_archive" "$crate_bytes"
  if ! python_helper extract-source \
    "$source_archive" \
    "$crate_bytes" \
    "$crate_sha256" \
    "$crate_root" \
    "$archive_max_entries" \
    "$expanded_bytes_max" \
    "$source_parent/extracted"; then
    fail "Typst source archive verification failed."
    return 1
  fi
  source_root="$source_parent/extracted/$crate_root"
  if ! python_helper verify-hash "$source_root/Cargo.lock" "$cargo_lock_sha256"; then
    fail "Typst Cargo.lock verification failed."
    return 1
  fi

  common_env=(
    HOME="$PRIVATE_HOME"
    LANG=C
    LC_ALL=C
    PATH=/usr/bin:/bin
    TMPDIR="$PRIVATE_TMP"
    RUSTUP_HOME="$rustup_home"
    CARGO_HOME="$private_cargo_home"
    CARGO_TARGET_DIR="$private_target"
    RUSTC="$rustc_bin"
    RUSTFLAGS=
    RUSTDOCFLAGS=
    CARGO_INCREMENTAL=0
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
    CARGO_TERM_COLOR=never
    CARGO_HTTP_TIMEOUT="$network_timeout"
    CARGO_NET_RETRY=2
    CARGO_NET_GIT_FETCH_WITH_CLI=false
    GIT_CONFIG_NOSYSTEM=1
    GIT_CONFIG_GLOBAL=/dev/null
    GIT_CEILING_DIRECTORIES="$WORK_ROOT"
    SOURCE_DATE_EPOCH="$source_date_epoch"
  )

  if ! cargo_info="$("$ENV_BIN" -i "${common_env[@]}" CARGO_ENCODED_RUSTFLAGS= "$cargo_bin" -Vv 2>"$WORK_ROOT/cargo-version.log")"; then
    fail "Cargo identity verification failed."
    return 1
  fi
  if ! rustc_info="$("$ENV_BIN" -i "${common_env[@]}" CARGO_ENCODED_RUSTFLAGS= "$rustc_bin" -vV 2>"$WORK_ROOT/rustc-version.log")"; then
    fail "Rust compiler identity verification failed."
    return 1
  fi
  require_version_line "$cargo_info" "release: $expected_cargo_version"
  require_version_line "$cargo_info" "commit-hash: $expected_cargo_commit"
  require_version_line "$cargo_info" "host: $triple"
  require_version_line "$rustc_info" "release: $expected_rustc_version"
  require_version_line "$rustc_info" "commit-hash: $expected_rustc_commit"
  require_version_line "$rustc_info" "host: $triple"

  separator=$'\x1f'
  encoded="--remap-path-prefix=$source_home=/build/home"
  encoded+="$separator--remap-path-prefix=$REPO_ROOT=/build/hexclaw-desktop"
  encoded+="$separator--remap-path-prefix=$source_home/.cargo=/build/cargo"
  encoded+="$separator--remap-path-prefix=$rustup_home=/build/rustup"
  encoded+="$separator--remap-path-prefix=$WORK_ROOT=/build/render"
  encoded+="$separator--remap-path-prefix=$private_cargo_home=/build/cargo"
  encoded+="$separator--remap-path-prefix=$private_target=/build/target"
  encoded+="$separator-C$separator"'link-arg=-Wl,-no_uuid'
  build_env=("${common_env[@]}" CARGO_ENCODED_RUSTFLAGS="$encoded")

  if ! "$ENV_BIN" -i "${build_env[@]}" "$cargo_bin" fetch \
    --locked \
    --manifest-path "$source_root/Cargo.toml" \
    --target "$triple" >"$WORK_ROOT/cargo-fetch.log" 2>&1; then
    fail "Typst dependency fetch failed."
    return 1
  fi
  if ! "$ENV_BIN" -i "${build_env[@]}" CARGO_NET_OFFLINE=true "$cargo_bin" install \
    --path "$source_root" \
    --locked \
    --offline \
    --no-track \
    --root "$install_root" \
    --target "$triple" >"$WORK_ROOT/cargo-build.log" 2>&1; then
    fail "Typst source build failed."
    return 1
  fi

  built_typst="$install_root/bin/typst"
  scan_typst_binary "$built_typst"
  verify_binary_architecture "$built_typst"
  verify_typst_version "$built_typst" "$version"
  if ! python_helper copy-regular "$built_typst" "$STAGE_DIR/$typst_output" 536870912; then
    fail "Typst source output staging failed."
    return 1
  fi
}

publish_outputs() {
  if ! python_helper "publish-$render_mode" "$STAGE_DIR" "$DEST_DIR" "$pandoc_output" "$typst_output"; then
    fail "render generation publication failed."
    return 1
  fi
}

stage_prebuilt_engine pandoc
if [ "$render_mode" = "prebuilt" ]; then
  stage_prebuilt_engine typst
else
  node_bin=''
  build_typst_from_source
  verify_binary_architecture "$STAGE_DIR/$pandoc_output"
fi
publish_outputs

printf 'PASS: render-bundle mode=%s target=%s.\n' "$render_mode" "$target"
