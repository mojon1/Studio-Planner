#!/bin/sh
# 公開するものだけを _site に集める。開発用のものは出さない。
# GitHub Actions からも、Cloudflare Pages / Netlify のビルドコマンドからも同じものを呼ぶ。
set -e
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site
for f in * .nojekyll; do
  case "$f" in test|tools|docs|_site|CLAUDE.md) continue ;; esac
  [ -e "$f" ] && cp -r "$f" _site/
done
touch _site/.nojekyll
ls -la _site
