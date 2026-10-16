.DEFAULT_GOAL := help
.PHONY: help install dev lint format format-check typecheck test test-determinism build hooks-install

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

dev: ## Run the Vite dev server
	pnpm dev

lint: ## Run ESLint
	pnpm lint

format: ## Format with Prettier
	pnpm format

format-check: ## Check formatting with Prettier
	pnpm format:check

typecheck: ## Type-check with tsc
	pnpm typecheck

test: ## Run Vitest
	pnpm test

test-determinism: ## Run the determinism soak and replay e2e tests
	pnpm test:determinism

build: ## Type-check and build with Vite
	pnpm build

hooks-install: ## Point git at .githooks
	git config core.hooksPath .githooks
