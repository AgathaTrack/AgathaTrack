#!/usr/bin/env bash
# Shared classifiers for public-access / teaser / Basic Auth smoke scripts.
# Source this file; do not execute directly (unless PAS_SMOKE_LIB_PROBE=1 for tests).
# shellcheck shell=bash

# True when HTML body is the coming-soon teaser (data-site-mode marker).
pas_is_teaser_html() {
  local body="${1:-}"
  [[ "$body" == *'data-site-mode="coming-soon"'* ]] \
    || [[ "$body" == *"data-site-mode='coming-soon'"* ]]
}

# True when path looks like a Flutter web bootstrap/asset path.
pas_is_flutter_asset_path() {
  local path="${1:-}"
  case "$path" in
    *main.dart.js*|*flutter.js*|*flutter_bootstrap.js*|*flutter_service_worker.js*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# True when body/text mentions Flutter main.dart.js (served app, not teaser).
pas_body_mentions_flutter_main() {
  local body="${1:-}"
  [[ "$body" == *'main.dart.js'* ]]
}

# Map HTTP status to a smoke failure kind (empty string = not classified by code alone).
# 401 → basic_auth (Directory Privacy / HTTP Basic Auth).
pas_classify_http_code() {
  local code="${1:-}"
  case "$code" in
    401) printf '%s\n' 'basic_auth' ;;
    *) printf '%s\n' '' ;;
  esac
}

# Classify GET on a Flutter bootstrap path during coming_soon prod smoke.
# Documented "asset absent" outcomes only:
#   absent          — HTTP 404 (file is not there)
#   teaser_fallback — HTTP 200 whose body is the coming-soon teaser and not Flutter
# Every other status is its own failure kind. A non-200 is not absence.
# Prints one of: absent | teaser_fallback | served | basic_auth | forbidden |
#   redirect | server_error | transport_error | http_error
pas_classify_flutter_asset_response() {
  local code="${1:-}"
  local body="${2:-}"
  # curl writes 000, or nothing, when the connection fails.
  if [[ -z "$code" || "$code" == "000" ]]; then
    printf '%s\n' 'transport_error'
    return 0
  fi
  case "$code" in
    200)
      if pas_is_teaser_html "$body" && ! pas_body_mentions_flutter_main "$body"; then
        printf '%s\n' 'teaser_fallback'
      else
        printf '%s\n' 'served'
      fi
      ;;
    404)
      printf '%s\n' 'absent'
      ;;
    401)
      printf '%s\n' 'basic_auth'
      ;;
    403)
      printf '%s\n' 'forbidden'
      ;;
    3*)
      printf '%s\n' 'redirect'
      ;;
    5*)
      printf '%s\n' 'server_error'
      ;;
    *)
      printf '%s\n' 'http_error'
      ;;
  esac
}

# Classify teaser vs Flutter mismatch given expected mode and observed body.
# Prints: ok | teaser_mismatch | flutter_served_in_teaser_mode
pas_classify_teaser_body() {
  local mode="${1:-}"
  local body="${2:-}"
  if [[ "$mode" == "coming_soon" ]]; then
    if ! pas_is_teaser_html "$body"; then
      printf '%s\n' 'teaser_mismatch'
      return 0
    fi
    if pas_body_mentions_flutter_main "$body"; then
      printf '%s\n' 'flutter_served_in_teaser_mode'
      return 0
    fi
  fi
  printf '%s\n' 'ok'
}

# Test probe: PAS_SMOKE_LIB_PROBE=<fn> bash public-access-smoke-lib.sh [args...]
if [[ "${PAS_SMOKE_LIB_PROBE:-}" != "" && "${BASH_SOURCE[0]}" == "${0}" ]]; then
  fn="$PAS_SMOKE_LIB_PROBE"
  case "$fn" in
    pas_is_teaser_html)
      if pas_is_teaser_html "${1:-}"; then echo true; else echo false; fi
      ;;
    pas_is_flutter_asset_path)
      if pas_is_flutter_asset_path "${1:-}"; then echo true; else echo false; fi
      ;;
    pas_body_mentions_flutter_main)
      if pas_body_mentions_flutter_main "${1:-}"; then echo true; else echo false; fi
      ;;
    pas_classify_http_code)
      pas_classify_http_code "${1:-}"
      ;;
    pas_classify_teaser_body)
      pas_classify_teaser_body "${1:-}" "${2:-}"
      ;;
    pas_classify_flutter_asset_response)
      pas_classify_flutter_asset_response "${1:-}" "${2:-}"
      ;;
    *)
      echo "unknown probe: $fn" >&2
      exit 2
      ;;
  esac
fi
