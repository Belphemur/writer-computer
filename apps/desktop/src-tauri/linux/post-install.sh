#!/bin/sh
# .deb and .rpm: the `writer` command is a link to the app binary, which main.rs runs as the CLI
# when started under that name. Only a free name or our own link (also on upgrade) is linked: a
# file, or another program's link, that the user or another package put there is never replaced.
link=/usr/bin/writer
if [ ! -e "$link" ] && [ ! -L "$link" ]; then
  ln -s writer-desktop "$link"
elif [ "$(readlink "$link" 2>/dev/null)" = writer-desktop ]; then
  ln -sf writer-desktop "$link"
fi
exit 0
