# Окружение otklik-kit: Claude Code, Bun, Chromium, pdftotext и, по желанию, humanizer-ru с Python.
# Папка проекта монтируется в /work (см. compose.yaml), в образ из неё ничего не копируется:
# резюме, письма и новые парсеры остаются на диске пользователя.
# Без humanizer-ru: docker compose build --build-arg HUMANIZER=0
FROM oven/bun:1 AS bun

FROM debian:bookworm-slim

ARG HUMANIZER=1

ENV LANG=C.UTF-8 \
    TZ=Europe/Moscow \
    CHROME_PATH=/usr/local/bin/chromium-docker \
    DISABLE_AUTOUPDATER=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tzdata poppler-utils chromium fonts-liberation \
 && if [ "$HUMANIZER" = "1" ]; then apt-get install -y --no-install-recommends python3 python3-venv; fi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# В контейнере песочница Chromium не поднимается, а /dev/shm маленький: флаги добавляет обёртка,
# скрипты находят её через CHROME_PATH.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/local/bin/chromium-docker \
 && chmod +x /usr/local/bin/chromium-docker

# Гейт ищет python с razdel и pymorphy3 первым по имени python.
RUN if [ "$HUMANIZER" = "1" ]; then python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir razdel pymorphy3; fi

# Папка проекта принадлежит пользователю хоста, без этого git ls-files в status.mjs молчит.
RUN git config --system --add safe.directory '*'

RUN useradd -m -u 1000 -s /bin/bash otklik
USER otklik
ENV HOME=/home/otklik \
    CLAUDE_CONFIG_DIR=/home/otklik/.claude \
    PATH=/home/otklik/.local/bin:/opt/venv/bin:$PATH

RUN curl -fsSL https://claude.ai/install.sh | bash

# Туда же, куда ставит npx skills add: ~/.agents/skills и ссылка из ~/.claude/skills.
RUN mkdir -p ~/.claude/skills ~/.agents/skills \
 && if [ "$HUMANIZER" = "1" ]; then \
      git clone --depth 1 https://github.com/ilyautov/humanizer-ru /tmp/humanizer \
      && f=$(grep -rl --include=SKILL.md '^name: humanizer-ru' /tmp/humanizer | head -n 1) \
      && [ -n "$f" ] \
      && cp -r "$(dirname "$f")" ~/.agents/skills/humanizer-ru \
      && rm -rf ~/.agents/skills/humanizer-ru/.git /tmp/humanizer \
      && ln -s ~/.agents/skills/humanizer-ru ~/.claude/skills/humanizer-ru; \
    fi

COPY --chmod=755 entrypoint.sh /usr/local/bin/otklik-entrypoint

WORKDIR /work
ENTRYPOINT ["otklik-entrypoint"]
CMD ["claude"]
