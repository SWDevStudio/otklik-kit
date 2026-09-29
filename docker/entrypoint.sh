#!/bin/sh
# ~/.claude лежит в томе Docker: том создаётся один раз, и ссылку на скилл из свежего образа
# в нём нужно восстановить.
if [ -d "$HOME/.agents/skills/humanizer-ru" ] && [ ! -e "$CLAUDE_CONFIG_DIR/skills/humanizer-ru" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/skills"
  ln -s "$HOME/.agents/skills/humanizer-ru" "$CLAUDE_CONFIG_DIR/skills/humanizer-ru"
fi

if [ ! -d /work/messages/scripts ]; then
  echo "otklik: папка проекта не смонтирована в /work, запускайте docker compose run --rm otklik из корня проекта" >&2
fi

exec "$@"
