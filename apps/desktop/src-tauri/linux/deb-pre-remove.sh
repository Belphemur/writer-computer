#!/bin/sh
# .deb: remove the `writer` link on removal, not on upgrade (the new package's post-install runs).
case "$1" in
  remove | purge)
    if [ "$(readlink /usr/bin/writer 2>/dev/null)" = writer-desktop ]; then
      rm -f /usr/bin/writer
    fi
    ;;
esac
exit 0
