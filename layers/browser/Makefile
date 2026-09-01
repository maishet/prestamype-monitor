build-BrowserDependenciesLayer:
	mkdir -p "$(ARTIFACTS_DIR)/nodejs"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/nodejs/"
	npm ci --omit=dev --prefix "$(ARTIFACTS_DIR)/nodejs"
