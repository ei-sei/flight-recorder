# Loaded before every project() in whisper.cpp's CMake build, via
# CMAKE_PROJECT_INCLUDE_BEFORE in .cargo/config.toml.
#
# ggml defaults GGML_NATIVE to ON, which compiles with -march=native: code
# tuned to whatever CPU the *build machine* has, not the user's. GitHub's
# runners are AVX-512 Xeons, so every release shipped AVX-512 (and AMX)
# instructions inside whisper.cpp. Any CPU without them - an i7-6700, every
# AMD chip before Zen 4, every consumer Intel from 12th gen on - died with
# SIGILL in ggml_vec_dot_f16 the moment transcription started, i.e. right
# after pressing Stop with Speech pace (WPM) on. Nothing is logged: the
# process is simply gone.
#
# With GGML_NATIVE off, ggml falls back to its fixed instruction-set options,
# which default to AVX + AVX2 + FMA + F16C and leave AVX-512 off. That runs on
# essentially every x86 PC from 2013 on and keeps the SIMD paths that matter
# most for whisper's speed.
#
# This has to go through a CMAKE_-prefixed variable because whisper-rs-sys
# 0.13's build.rs only forwards WHISPER_* and CMAKE_* env vars to CMake - a
# plain GGML_NATIVE=OFF would be silently dropped. The WHISPER_NATIVE alias
# can't be used either: whisper.cpp only ever maps it to ON, never OFF.
# CACHE ... FORCE because option() won't override an existing cache entry,
# which is exactly what makes this stick.
set(GGML_NATIVE OFF CACHE BOOL "Never tune ggml to the build machine's CPU" FORCE)
