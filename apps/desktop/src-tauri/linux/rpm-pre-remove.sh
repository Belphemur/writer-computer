#!/bin/sh
# .rpm: remove the `writer` link on erase ($1 is 0), not on upgrade ($1 is 1).
if [ "$1" = 0 ] && [ "$(readlink /usr/bin/writer 2>/dev/null)" = writer-desktop ]; then
  rm -f /usr/bin/writer
fi
exit 0
