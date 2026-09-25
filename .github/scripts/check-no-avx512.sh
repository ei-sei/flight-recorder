#!/usr/bin/env bash
# Fails if any ggml (whisper.cpp) function in the given binary uses an
# AVX-512 (zmm) register.
#
# Releases up to v1.6.3 shipped whisper.cpp compiled with -march=native on an
# AVX-512 runner, and the app died with SIGILL on any CPU without AVX-512 the
# moment transcription started. It builds, passes every test and runs fine on
# the runner itself, so nothing else catches it. See ggml-portable.cmake.
set -euo pipefail
bin="$1"
hits=$(objdump -d --no-show-raw-insn "$bin" | awk '
  /^[0-9a-f]+ <[^>]*>:$/ { fn = $2; inggml = (fn ~ /ggml/); next }
  inggml && /zmm[0-9]/ { n[fn]++ }
  END { for (f in n) print n[f], f }')
if [ -n "$hits" ]; then
  echo "::error::ggml in $bin was built with AVX-512 and will crash CPUs without it:"
  echo "$hits" | sort -rn | head -20
  exit 1
fi
# Guards against the check passing vacuously - a stripped binary or a renamed
# symbol would otherwise read as "no AVX-512 found".
# Not grep -q: it exits on the first match, objdump then dies of SIGPIPE, and
# pipefail reports the whole pipeline as failed even though it matched.
if ! objdump -t "$bin" | grep 'ggml_vec_dot_f16' >/dev/null; then
  echo "::error::no ggml symbols found in $bin - the AVX-512 check can't see anything to check"
  exit 1
fi
echo "ok: no AVX-512 in any ggml function in $bin"
