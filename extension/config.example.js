"use strict";
/**
 * Copy this file to config.js and fill it in. config.js is git-ignored on purpose —
 * it holds the token and the cookie encryption key, and this repo is public.
 *
 * token: fine-grained personal access token limited to this repository, with one
 * permission — "Actions: Read and write". That covers dispatching the workflow,
 * reading run status and downloading the artifact, and nothing else.
 *
 * cookieKey: 64 hex chars. Must be the same value as the COOKIE_KEY repo secret.
 * Generate one with:  python -c "import secrets; print(secrets.token_hex(32))"
 *
 * Everything here is only a default — whatever you set on the options page wins.
 */
const DEFAULT_CONFIG = {
  owner: "rafi434088-hash",
  repo: "youtube-proxy",
  workflow: "download.yml",
  ref: "main",
  token: "",
  cookieKey: ""
};

if (typeof self !== "undefined") self.DEFAULT_CONFIG = DEFAULT_CONFIG;
