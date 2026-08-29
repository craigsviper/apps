#!/bin/bash
# update-github.sh — one command instead of remembering the git sequence every time.
#
# Usage:
#   ./update-github.sh
#
# What it does:
#   1. Stages and commits everything changed in this folder
#   2. Pushes to GitHub (main branch)
#   3. Asks if you want to tag this version and trigger the Android APK build too
#
# This assumes you've already run `git remote add origin ...` once (the initial setup).
# If `git push` fails asking for a password, use a GitHub Personal Access Token instead —
# see android/README.md.

set -e
cd "$(dirname "$0")"

VERSION=$(grep -m1 '"version"' package.json | sed -E 's/.*"([0-9.]+)".*/\1/')
TAG="v$VERSION"

echo "=== RSW Field App -> GitHub ==="
echo "Detected app version: $VERSION"
echo

read -rp "Commit message (Enter for default 'Update $TAG'): " MSG
MSG=${MSG:-"Update $TAG"}

git add .
if git diff --cached --quiet; then
  echo "(nothing changed — skipping commit)"
else
  git commit -m "$MSG"
fi

echo "Pushing to GitHub..."
git push origin main

echo
read -rp "Tag this as $TAG and trigger the Android build too? [y/N] " YN
if [[ "$YN" =~ ^[Yy]$ ]]; then
  # -f in case this exact tag was already pushed before (e.g. re-running after a fix)
  git tag -f "$TAG"
  git push origin "$TAG" --force
  echo
  echo "Tagged and pushed $TAG."
  echo "Check the build at: https://github.com/craigsviper/rsw-field-app/actions"
  echo "APK will appear at: https://github.com/craigsviper/rsw-field-app/releases (once green)"
else
  echo "Skipped tagging — code is pushed, but no Android build was triggered."
fi
