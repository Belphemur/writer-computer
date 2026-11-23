#!/bin/sh
# .deb and .rpm: the `writer` command is a link to the app binary, which main.rs runs as the CLI
# when started under that name. A file the user put there is never replaced.
if [ ! -e /usr/bin/writer ] || [ -L /usr/bin/writer ]; then
  ln -sf writer-desktop /usr/bin/writer
fi
exit 0
