#!/bin/bash
# Bumps the RSW Field App version string across every file that needs it.
# Run from inside app_pkg/. Usage: bump_version.sh OLD NEW
# Example:                        bump_version.sh 73.1 73.2
set -e
OLD="$1"
NEW="$2"
if [ -z "$OLD" ] || [ -z "$NEW" ]; then
  echo "Usage: bump_version.sh OLD_VERSION NEW_VERSION   (e.g. 73.1 73.2)"
  exit 1
fi

sed -i "s/\"version\": \"${OLD}.0\"/\"version\": \"${NEW}.0\"/" package.json
sed -i "s/\"version\": \"${OLD}.0\"/\"version\": \"${NEW}.0\"/" host-server/sync-server/package.json
sed -i "s/APP_SCHEMA_VERSION = '${OLD}'/APP_SCHEMA_VERSION = '${NEW}'/" host-server/sync-server/server.js
sed -i "s/CACHE_NAME = 'rsw-app-v${OLD}'/CACHE_NAME = 'rsw-app-v${NEW}'/" public/sw.js
sed -i "s/v${OLD}/v${NEW}/g" docker-compose.yml host-server/docker-compose.yml Dockerfile README.md INSTALL-GUIDE.md
sed -i "s/com.rsw.version=${OLD}/com.rsw.version=${NEW}/" docker-compose.yml host-server/docker-compose.yml
sed -i "s/LABEL version=\"${OLD}.0\"/LABEL version=\"${NEW}.0\"/" Dockerfile

echo "── Verifying no stray v${OLD} left (docx and CLAUDE_CONTEXT.md's historical changelog table are NOT auto-bumped — do those manually) ──"
grep -rln "v${OLD}\b" --include="*.json" --include="*.js" --include="*.yml" --include="*.md" . 2>/dev/null | grep -v -e node_modules -e '^\./dist/' || echo "clean — no stray v${OLD} in json/js/yml/md files"

echo ""
echo "Still needed manually:"
echo "  1. RSW-Update-and-Install-Guide.docx — see SKILL.md §3 (never read+write same zip path)"
echo "  2. CLAUDE_CONTEXT.md — version table (~line 33-37) + Recent History row"
echo "  3. CHANGELOG.md + host-server/CHANGELOG.md — new entries"
