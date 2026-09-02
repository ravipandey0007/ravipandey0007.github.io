---
title: "dyld Shared Cache Extraction on Windows"
description: "A field-tested, no-Mac-required procedure for pulling and parsing a real iOS dyld_shared_cache entirely from a Windows machine — with every gotcha hit along the way."
categories: [macos-ios]
tags: [dyld, dyld_shared_cache, apfs, ipsw, ios, mach-o, wsl, apfs-fuse, windows, reverse-engineering]
---

Apple ships iOS system libraries pre-linked into one opaque cache file — there are no individual `.dylib`s on disk to point a disassembler at. Getting one out normally means a Mac: mount the IPSW's system image with `hdiutil`, run Apple's own extractor. None of that exists on Windows. This is the pipeline that reconstructs the same result out of open-source pieces, plus every place it broke along the way.

**Verified against:** iPhone15,2, iOS 26.6.1 (build 23G83) — result: 4317 images, 83 subCaches, 5.9&nbsp;GB, arm64e.

## The shape of the pipeline

```text
.ipsw (remote zip)
   │
   ▼
AEA decrypt              ipsw fw aea
   │
   ▼
raw APFS image           no UDIF wrapper, ~5–9 GB
   │
   ▼
WSL2 Ubuntu               apfs-fuse mount (read-only)
   │
   ▼
dyld_shared_cache + subCaches      copied back to Windows
   │
   ▼
ipsw dyld info             verify
```

The short version: [`ipsw`](https://github.com/blacktop/ipsw) (Windows-native) downloads and AEA-decrypts the firmware image fine, but it can't *read* the resulting Apple filesystem image on Windows — that step needs a real APFS driver, which only exists as Linux/macOS FUSE code. So WSL2 carries that one step; everything else stays on the Windows side.

## Prerequisites

- Windows 10/11 with `winget` available.
- WSL2 with an Ubuntu distro installed (`wsl --install` if you don't have one — this used Ubuntu-20.04, any recent Ubuntu behaves the same).
- A sudo password for that WSL user, typed by you, in your own terminal, twice. No way around this — see [why](#why-sudo-cant-be-scripted) below.
- ~30–40 GB free disk space. System images decrypt to several gigabytes each, and this keeps two around at once.

## 1 · Install ipsw

[blacktop/ipsw](https://github.com/blacktop/ipsw) is the one tool here that's genuinely Windows-native — a real Windows binary, on `winget`, no WSL involved for this part.

```powershell
winget install --id blacktop.ipsw --accept-source-agreements --accept-package-agreements
ipsw version
```

The install adds a WinGet package path to `PATH`, but only in *new* shells — reference the binary directly for the rest of the current session if needed:

```powershell
$env:Path += ";C:\Users\<you>\AppData\Local\Microsoft\WinGet\Packages\blacktop.ipsw_Microsoft.Winget.Source_8wekyb3d8bbwe"
```

## 2 · Get the IPSW URL

No need to download the full multi-gigabyte IPSW — `ipsw` can range-fetch just the pieces it needs from Apple's CDN. Resolve the direct URL for your device and build first:

```powershell
ipsw download ipsw --device iPhone15,2 --latest --urls -y
```

That prints the signed `https://updates.cdn-apple.com/...Restore.ipsw` URL for the current build — every command below reuses it. Swap in `--version 17.5` (or similar) instead of `--latest` for a specific release, and `--device` for any identifier from [theiphonewiki.com's model list](https://www.theiphonewiki.com/wiki/Models).

## 3 · Know which volume actually has the cache

This is the step that cost the most time, so it's worth understanding before running anything: a modern IPSW doesn't contain one filesystem image — it contains several APFS volumes on different DMGs, and `dyld_shared_cache` is *not* on the one you'd guess.

<div class="tbl-wrap" markdown="1">

| `ipsw --dmg` value | what it actually is | has the dyld cache? |
|---|---|---|
| `fs` | SystemOS — the small boot volume. `/System/Library/Caches/` exists but only holds `com.apple.kernelcaches` and `com.apple.factorydata`. `/System/Cryptexes/OS` is a symlink out to the Preboot volume — also a dead end. | No |
| `app` | Produced a suspiciously exact, reproducible **~14 MB** file on every run — not a real volume dump. Don't use it. | No (broken) |
| `sys` | The volume actually holding the cache. Its APFS *container* holds multiple volumes; the one with content mounts under `root/`. Same dmg id that `ipsw extract --dyld --remote` tries (and fails) to auto-mount internally — going straight to `--dmg sys` just skips that failed attempt. | **Yes** |

</div>

<div class="callout warn" markdown="1">
**Don't trust the label.** Nothing here is documented by `ipsw` itself — these mappings were reverse-engineered by comparing dmg IDs across runs. They held for a current (2026) iOS build; if Apple reshuffles the partition layout on a future OS version, verify before assuming `sys` is still right: run `ipsw extract --dyld --dyld-arch arm64e --remote` against your URL. It fails at the final mount step (expected — see step 5), but its error message names the exact dmg id it tried to mount, e.g. `094-97222-091.dmg`. Whichever `--dmg` flag reproduces that same id is the one to use.
</div>

## 4 · Extract and decrypt the image

Pull the raw DMG out of the IPSW zip, then decrypt Apple's AEA (Apple Encrypted Archive) wrapper around it — two separate steps, both native on Windows via `ipsw`.

```powershell
$url = "https://updates.cdn-apple.com/…/iPhone15,2_…_Restore.ipsw"

ipsw extract --dmg sys --remote -o "C:\dyld-research\caches" $url
```

This produces a `<buildid>.dmg.aea` file — still encrypted. Decrypt it separately:

```powershell
ipsw fw aea -o "C:\dyld-research\caches" "C:\dyld-research\caches\094-97222-091.dmg.aea"
```

Output is a plain `.dmg` — but not the kind `hdiutil` or Apple's own extractor tools expect. It's a **raw APFS container image with no UDIF wrapper** (no `koly` trailer at the end of the file). That distinction is why the WSL mount step below can't be skipped.

<div class="callout good" markdown="1">
**Checkpoint.** You should now have a multi-gigabyte `.dmg` file that starts with the bytes `4e 58 53 42` (`"NXSB"`, the APFS container magic) at offset `0x20`. If `xxd -l 64 yourfile.dmg | grep NXSB` finds nothing, the AEA decrypt step didn't actually run.
</div>

## 5 · Build a real APFS reader in WSL

Windows has no APFS driver, and no Windows build of a FUSE-based one exists. [`apfs-fuse`](https://github.com/sgan81/apfs-fuse) — the actively-maintained C++ driver used across the forensics/RE community — builds and runs fine under WSL2; it just needs compiling from source.

<div class="callout warn" markdown="1">
<a name="why-sudo-cant-be-scripted"></a>**Why this part can't be automated.** `sudo`'s password prompt writes directly to the controlling terminal device, bypassing normal stdout/stderr. Anything running `wsl.exe … -- sudo …` without a real interactive terminal attached just hangs forever with no way to answer the prompt. **Run the two `apt` commands below yourself**, in a terminal you're typing into — everything after that can be scripted normally.
</div>

**5.1 · Install build dependencies**

```bash
wsl -d Ubuntu-20.04 -- sudo apt update
wsl -d Ubuntu-20.04 -- sudo apt install -y build-essential cmake libfuse-dev libbz2-dev zlib1g-dev libattr1-dev git
```

<div class="callout warn" markdown="1">
**fuse2 vs fuse3.** `libfuse-dev` (fuse2) is enough to build `apfsutil` and `apfs-dump`, but *not* the actual `apfs-fuse` mount binary — that target needs `fuse3/fuse.h`. You'll hit `fatal error: fuse3/fuse.h: No such file or directory` without the second package below. Ubuntu 20.04's `fuse3` package also removes the old `fuse` (2.x) meta-package on install — expected and harmless; `libfuse2` stays.
</div>

```bash
wsl -d Ubuntu-20.04 -- sudo apt install -y libfuse3-dev fuse3
```

**5.2 · Clone and build apfs-fuse** — everything from here on runs non-interactively, no more `sudo` needed:

```bash
wsl -d Ubuntu-20.04 -- bash -lc "
  git clone --recursive https://github.com/sgan81/apfs-fuse.git ~/apfs-fuse &&
  mkdir -p ~/apfs-fuse/build && cd ~/apfs-fuse/build &&
  cmake .. -DCMAKE_BUILD_TYPE=Release &&
  make -j\$(nproc)
"
```

A successful build leaves `~/apfs-fuse/build/apfs-fuse` alongside three other useful binaries: `apfsutil`, `apfs-dump`, and `apfs-dump-quick` (all read-only inspection tools, no mount required).

## 6 · Mount and pull the cache out

Windows drives are already visible inside WSL2 under `/mnt/c/…`, so the DMG from step 4 doesn't need copying anywhere — mount it in place.

<div class="callout warn" markdown="1">
**Gotcha: commas in the path.** `apfs-fuse` builds an internal FUSE mount-option string by embedding the raw device path, comma-separated. A path containing a literal comma — e.g. a folder `ipsw` itself names `iPhone15,2` — splits that string wrong and fails with a cryptic `fuse: unknown option(s): -o …`. Move or rename the DMG to a comma-free path first.
</div>

```powershell
Move-Item "C:\dyld-research\caches\23G83__iPhone15,2\094-97222-091.dmg" `
          "C:\dyld-research\caches\clean\sys.dmg"
```

```bash
wsl -d Ubuntu-20.04 -- bash -lc "
  mkdir -p ~/apfs_mnt
  ~/apfs-fuse/build/apfs-fuse /mnt/c/dyld-research/caches/clean/sys.dmg ~/apfs_mnt &
  sleep 5
  mount | grep apfs
  ls ~/apfs_mnt
"
```

The container has more than one volume, so `apfs-fuse` mounts each as a subdirectory rather than exposing one root. The content volume shows up as `root/`:

```text
drw-r--r-- 1 root root 0 … private-dir
drwxr-xr-x 1 root root 2 … root

$ ls ~/apfs_mnt/root/
System  usr

$ ls ~/apfs_mnt/root/System/Library/Caches/com.apple.dyld/
dyld_shared_cache_arm64e
dyld_shared_cache_arm64e.01
dyld_shared_cache_arm64e.02
…
dyld_shared_cache_arm64e.symbols
```

There it is — the base cache plus somewhere from a few dozen to ~90 numbered subCache files (typed segments show up with suffixes like `.dylddata`, `.dyldreadonly`, `.dyldlinkedit`, plus a `.symbols` and an `.atlas` file on recent OS versions). Copy all of it out through the same `/mnt/c` bridge:

```bash
wsl -d Ubuntu-20.04 -- bash -lc "
  mkdir -p /mnt/c/dyld-research/extracted/dyld_shared_cache_arm64e
  cp -v ~/apfs_mnt/root/System/Library/Caches/com.apple.dyld/dyld_shared_cache_arm64e* \
        /mnt/c/dyld-research/extracted/dyld_shared_cache_arm64e/
"
```

This copies several gigabytes through a FUSE mount over the WSL/Windows filesystem bridge — expect a few minutes, not seconds. When it's done, unmount cleanly:

```bash
wsl -d Ubuntu-20.04 -- bash -lc "fusermount -u ~/apfs_mnt"
```

## 7 · Verify with ipsw

Back on the Windows side, point `ipsw`'s own dyld-cache parser at the base file — it automatically discovers and reads every numbered subCache alongside it.

```powershell
ipsw dyld info "C:\dyld-research\extracted\dyld_shared_cache_arm64e\dyld_shared_cache_arm64e"
```

```text
Magic          = "dyld_v1  arm64e"
Platform       = iOS
OS Version     = 26.6
Format         = 0 (NewFormatTLVs)
Max Slide      = 0x20000000 (ASLR entropy: 15-bits, 512MB)
Num Images     = 4317
Num SubCaches  = 83

Shared Region:  5GB, address: 0x180000000 -> 0x2C2C44000
> Cache UUID: 26E012B3-CA41-3F93-A23C-9296EB9C09DC
```

From here, the rest of `ipsw`'s `dyld` subcommands work exactly as documented — `ipsw dyld macho` to pull a single framework back out as a standalone Mach-O, `ipsw dyld imports`, `ipsw dyld a2s` for address-to-symbol lookups, and so on. The hard part — getting bytes off the IPSW and into a shape any tool can parse — is done.

## Troubleshooting reference

Every one of these was hit at least once building this pipeline.

**`fuse: unknown option(s): '-o <fragment of your path>'`**
Your DMG's path contains a comma; `apfs-fuse` embeds the raw path into a comma-delimited mount-option string internally and doesn't escape it. Fix: move the file to a comma-free path (step 6).

**`sudo` hangs forever, zero output, no visible prompt**
`sudo` writes its password prompt straight to `/dev/tty`, not stdout/stderr, so redirecting or capturing output doesn't reveal it — and if nothing is attached to answer that tty, the process blocks indefinitely. Happens on *every* `wsl.exe … -- sudo …` invocation not run from a real interactive terminal, even right after an earlier `sudo` succeeded in that same distro — the cached credential ticket doesn't reliably carry across separate invocations. Fix: kill the hung process and run that specific command yourself, in a terminal you're typing into. There's no safe way to script around this.

**`apt-get` itself hangs (separately from the sudo-password issue)**
`apt`/`dpkg` allocate a pty for progress reporting by default; without one properly attached this can also stall indefinitely, independent of authentication. Fix: add `-o Dpkg::Use-Pty=0`, run with `DEBIAN_FRONTEND=noninteractive` and stdin redirected from `/dev/null`. Still needs a human if it also needs `sudo`.

**Git Bash / MSYS mangles paths like `/System/Library/…` into `C:/Program Files/Git/System/Library/…`**
MSYS auto-translates any argument that looks like a POSIX absolute path into a Windows path rooted at the Git install dir — correct for real file paths, wrong for an in-image path passed as a plain string. Fix: prefix the argument with an extra leading slash (`//System/Library/…`, MSYS's documented escape), or set `MSYS_NO_PATHCONV=1` and pre-convert every *real* path to native Windows form with `cygpath -w` first.

**`winget install` hangs indefinitely at "Extracting archive…"**
No confirmed root cause — seen with a small (<100 MB) package that should extract in seconds, not reproducible every time. Fix: kill it and fetch the release directly (`curl -L -o pkg.zip <url>` then `Expand-Archive` / `unzip`) — faster than waiting or retrying.

**`ipsw` errors: `failed to find apfs-fuse: apfs-fuse not found in PATH`**
`ipsw`'s own `--dyld`, `--files`, and `mount` paths all shell out to an external `apfs-fuse` binary for any content-aware read of the decrypted system image, and no Windows build exists. This is the reason the WSL detour (steps 5–6) exists at all — there's no flag around it on Windows.

## Appendix · the pure-Go path that almost worked

Before reaching for WSL, this was attempted entirely in native Windows Go — no mounting, no Linux, reading the raw APFS bytes directly. Included here because it's genuinely useful for *older or simpler* volumes, and the bug found along the way is worth knowing about.

[blacktop/go-apfs](https://github.com/blacktop/go-apfs) is a pure-Go APFS parser — no mount needed. Its LZFSE decompression dependency (`lzfse-cgo`) is cgo-only though, so building it still needs a C compiler. [zig](https://ziglang.org), used purely as `zig cc`, works as a drop-in CGO compiler on Windows with a single ~100 MB download — no MSVC or MinGW install needed:

```powershell
winget install --id GoLang.Go
curl -L -o zig.zip https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip
# unzip it, then:
$env:CGO_ENABLED = "1"
$env:CC = "C:\path\to\zig\zigcc.cmd"   # a 2-line wrapper: zig.exe cc %*
go install github.com/blacktop/go-apfs/cmd/apfs@latest
```

<div class="callout dead" markdown="1">
**Bug found: path separator.** The library's path-walking code splits on `filepath.Separator`, which is `\` on a Windows build. Any forward-slash path (i.e. every real APFS path) silently fails to split into components, so lookups below the volume root always miss. Converting `/` to `\` before calling into the library fixes it — a two-line workaround, no fork needed.
</div>

<div class="callout dead" markdown="1">
**Where it stops working.** Even fixed, `go-apfs` only understands APFS on-disk structures up to roughly the 2020 specification. Older/simpler volumes (this guide's SystemOS dead-end from step 3, for instance) parse fine. The volume that actually holds the dyld cache on a current iOS build uses newer B-tree structures the library doesn't recognize, and fails with `unknown or unsupported obj header type OBJECT_TYPE_INVALID` while reading the root object — not fixable without real archaeology against Apple's current on-disk format.
</div>

Worth reaching for this path first if targeting an older iOS build (roughly pre-2022), where it's more likely to just work — and it never costs anything to try, since it fails fast and cleanly rather than hanging, unlike the WSL/sudo issues above. For anything current, skip straight to step 5.
