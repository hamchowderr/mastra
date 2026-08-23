---
'@mastra/core': minor
---

Added a `wsl2` isolation backend for `LocalSandbox` on Windows, running sandboxed commands inside a WSL2 distro instead of directly on the Windows host. Requires the target distro to have WSL interop disabled; layers `bwrap` for namespace/network isolation when it's also installed in the distro.
