# Version comparison for the release scripts, which source this file (POSIX sh).
#
# later A B: A is a later version than B. Major, minor and patch compare as numbers; with those
# equal, a release is later than its prereleases, and two prereleases compare as text.
later() {
  a=$1
  b=$2
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split each core into its three numbers
  set -- ${a%%-*} ${b%%-*}
  IFS=$old_ifs
  [ "$1" -ne "$4" ] && {
    [ "$1" -gt "$4" ]
    return
  }
  [ "$2" -ne "$5" ] && {
    [ "$2" -gt "$5" ]
    return
  }
  [ "$3" -ne "$6" ] && {
    [ "$3" -gt "$6" ]
    return
  }
  case "$a,$b" in
    *-*,*-*) [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | LC_ALL=C sort | tail -n 1)" = "$a" ] ;;
    *-*,*) return 1 ;;
    *,*-*) return 0 ;;
    *) return 1 ;;
  esac
}

# is_version V: V is a version like 1.2.3 or 1.2.3-rc.1, with no leading v, on one line. grep reads
# a line at a time, so anything but the characters of a version (a line break, say) is refused first.
is_version() {
  case $1 in
  '' | *[!0-9A-Za-z.-]*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}
