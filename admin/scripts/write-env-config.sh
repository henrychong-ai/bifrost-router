#!/bin/sh
# Write the dashboard's runtime env config (v1.37.0), read by admin/src/env.ts.
#
# The values come from the container environment, so the API key never enters
# the image or its build cache. Each value is written as a JSON string literal:
# `\`, `"` and control characters are escaped, so no value can end the string
# or add script to env-config.js.
#
# Usage: write-env-config.sh <output>
set -eu

output=$1

# json_string VALUE: VALUE as a JSON string literal, quotes included. The
# trailing `x` keeps trailing newlines (awk would drop the last one) and is
# removed again before printing; every line break becomes `\n`.
json_string() {
  printf '%sx' "$1" | awk '
    BEGIN {
      for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
      esc["\\"] = "\\\\"
      esc["\""] = "\\\""
    }
    { lines[NR] = $0 }
    END {
      lines[NR] = substr(lines[NR], 1, length(lines[NR]) - 1)
      printf "\""
      for (r = 1; r <= NR; r++) {
        if (r > 1) printf "\\n"
        n = length(lines[r])
        for (i = 1; i <= n; i++) {
          c = substr(lines[r], i, 1)
          printf "%s", ((c in esc) ? esc[c] : c)
        }
      }
      printf "\""
    }'
}

# Encode first, as an assignment: `set -e` stops the script if the encoder
# fails. Inside printf's argument list the failure would be ignored and a
# broken env-config.js written.
value=$(json_string "${ADMIN_API_KEY:-}")

tmp="$output.tmp"
printf 'window.__ENV__ = { "ADMIN_API_KEY": %s };\n' "$value" >"$tmp"
mv "$tmp" "$output"
