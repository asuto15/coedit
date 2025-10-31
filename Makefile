.PHONY: up down logs ps restart web-shell server-shell test fmt diagnose

APP_ENV ?= prod # dev | prod

up:
	VAULT_PATH="$${VAULT_HOST_PATH:-./vault}"; if [ ! -e "$$VAULT_PATH" ]; then mkdir -p "$$VAULT_PATH"; fi
	APP_ENV=$(APP_ENV) docker compose up -d --build

down:
	docker compose down

logs:
	APP_ENV=$(APP_ENV) docker compose logs -f nginx web server

ps:
	APP_ENV=$(APP_ENV) docker compose ps

restart:
	APP_ENV=$(APP_ENV) docker compose restart

web-shell:
	APP_ENV=$(APP_ENV) docker compose exec web bash

server-shell:
	APP_ENV=$(APP_ENV) docker compose exec server bash

test:
	APP_ENV=$(APP_ENV) docker compose exec server bash -lc 'cd /workspace && cargo test'

fmt:
	APP_ENV=$(APP_ENV) docker compose exec server bash -lc 'cd /workspace && cargo fmt && cargo fmt && cargo clippy -- -D warnings'

lint:
	APP_ENV=$(APP_ENV) docker compose exec web bash -lc 'cd /workspace && yarn lint'
