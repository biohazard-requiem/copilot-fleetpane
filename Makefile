.PHONY: build test test-go test-node vet install uninstall dist

build:
	go build -trimpath -o bin/fleetpane ./cmd/fleetpane

test: test-go test-node

test-go:
	go test ./...

test-node:
ifeq ($(wildcard test/extension/*.test.mjs),)
	@echo "test-node: no test/extension/*.test.mjs yet, skipped"
else
	node --test test/extension/*.test.mjs
endif

vet:
	go vet ./...
	find extension hack test -name '*.mjs' -print0 | xargs -0 -n1 node --check

install: build
	hack/install.sh

uninstall:
	hack/uninstall.sh

dist:
	hack/dist.sh
