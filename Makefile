# Every check the release workflow runs on a develop -> main pull request, run
# the same way here first. CI's runner has Node 22 already; locally mise gives it.
RUN := $(if $(CI),,mise exec node@22 --)
MANIFEST := plugins/effort-live-control/.claude-plugin/plugin.json

.PHONY: release-check check release

release-check: check release

check:
	$(RUN) npm ci
	$(RUN) npm test
	$(RUN) npm run typecheck
	CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 $(RUN) npm run validate:plugin

# Run `git fetch origin main` first: the version must move past main's.
release:
	@git rev-parse --verify -q origin/main >/dev/null || { echo "origin/main is missing from the checkout"; exit 1; }
	base=$$(if git cat-file -e "origin/main:$(MANIFEST)" 2>/dev/null; then git show "origin/main:$(MANIFEST)" | $(RUN) node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; else echo "main has no $(MANIFEST): treating this as the first release" >&2; echo 0.0.0; fi) && \
	$(RUN) scripts/release-check.sh "$$base"
	v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	v_re=$$(printf '%s' "$$v" | sed 's/[.]/[.]/g'); \
	awk -v v="$$v_re" '$$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ || /^\[/ {f=0} f' CHANGELOG.md | grep -q '' || { echo "FAIL CHANGELOG.md section for $$v yields no release notes"; exit 1; }
