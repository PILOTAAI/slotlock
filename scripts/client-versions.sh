# The language clients' version, for the release scripts, which source this file (POSIX sh). Each
# client carries the package version in its manifest and in the constant its User-Agent sends:
# scripts/prepare-release.sh moves every one to the release, scripts/check-release-tag.sh refuses a
# release where one disagrees, and scripts/open-release-pr.sh commits them. A file a checkout does
# not have is skipped, so the scripts work in a repository without clients/.
CLIENT_VERSION_FILES='clients/python/pyproject.toml
clients/python/src/slotlock/_transport.py
clients/rust/Cargo.toml
clients/rust/Cargo.lock
clients/java/build.gradle.kts
clients/java/src/main/java/io/pylota/slotlock/SlotlockClient.java
clients/dotnet/src/Slotlock/Slotlock.csproj
clients/dotnet/src/Slotlock/SlotlockClient.cs
clients/go/client.go'

# client_version_line FILE VERSION: the whole line in FILE that names VERSION. In Cargo.lock it is
# the line after `name = "slotlock"`.
client_version_line() {
  case $1 in
  */pyproject.toml | */Cargo.toml | */Cargo.lock | */build.gradle.kts) printf 'version = "%s"' "$2" ;;
  */_transport.py) printf '__version__ = "%s"' "$2" ;;
  */SlotlockClient.java) printf '  public static final String VERSION = "%s";' "$2" ;;
  */Slotlock.csproj) printf '    <Version>%s</Version>' "$2" ;;
  */SlotlockClient.cs) printf '    public const string Version = "%s";' "$2" ;;
  */client.go) printf 'const Version = "%s"' "$2" ;;
  *) return 1 ;;
  esac
}

# client_version_holds FILE VERSION: FILE's text, on stdin, names VERSION on its version line.
client_version_holds() {
  case $1 in
  */Cargo.lock)
    awk -v want="$(client_version_line "$1" "$2")" '
      after { found = ($0 == want); exit }
      $0 == "name = \"slotlock\"" { after = 1 }
      END { exit !found }'
    ;;
  *) grep -Fqx -- "$(client_version_line "$1" "$2")" ;;
  esac
}

# client_versions_check VERSION [COMMIT]: every client file in the checkout, or at COMMIT, names
# VERSION. Prints the first file that does not, and returns 1.
client_versions_check() {
  for cv_file in $CLIENT_VERSION_FILES; do
    if [ -n "${2:-}" ]; then
      git cat-file -e "$2:$cv_file" 2>/dev/null || continue
      git show "$2:$cv_file" | client_version_holds "$cv_file" "$1" || {
        echo "$cv_file"
        return 1
      }
    else
      [ -f "$cv_file" ] || continue
      client_version_holds "$cv_file" "$1" <"$cv_file" || {
        echo "$cv_file"
        return 1
      }
    fi
  done
}

# client_versions_set OLD NEW: moves every client file in the checkout from OLD to NEW, the rest of
# each file byte for byte, then checks it. Prints the first file left behind, and returns 1.
client_versions_set() {
  for cv_file in $CLIENT_VERSION_FILES; do
    [ -f "$cv_file" ] || continue
    cv_old=$(client_version_line "$cv_file" "$1")
    cv_new=$(client_version_line "$cv_file" "$2")
    case $cv_file in
    */Cargo.lock)
      awk -v old="$cv_old" -v new="$cv_new" '
        after && $0 == old { $0 = new }
        { after = ($0 == "name = \"slotlock\""); print }' "$cv_file" >"$cv_file.tmp"
      ;;
    *) awk -v old="$cv_old" -v new="$cv_new" '$0 == old { $0 = new } { print }' "$cv_file" >"$cv_file.tmp" ;;
    esac
    mv "$cv_file.tmp" "$cv_file"
  done
  client_versions_check "$2"
}

# client_version_paths: the client files the checkout has, one per line.
client_version_paths() {
  for cv_file in $CLIENT_VERSION_FILES; do
    [ -f "$cv_file" ] && echo "$cv_file"
  done
  return 0
}
