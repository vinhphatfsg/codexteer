PREFIX ?= $(HOME)/.local

.PHONY: deps check test install-local uninstall-local

deps:
	npm ci --ignore-scripts

check:
	npm run check

test:
	npm test

install-local: deps
	$(MAKE) check test
	mkdir -p "$(PREFIX)/bin"
	ln -sfn "$(CURDIR)/bin/codex-steer.mjs" "$(PREFIX)/bin/codex-steer"

uninstall-local:
	rm "$(PREFIX)/bin/codex-steer"
