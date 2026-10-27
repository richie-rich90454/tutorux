# Archive fixtures

## `encrypted-v1.tux`

This 3,080-byte fixture was written by the repository's C++ archive implementation using the
`archive encrypt` command. It contains synthetic data for one student named `Interop Student`.
The fixture passphrase is `Tutorux cross-language fixture phrase 2026`; it is test-only and must
not be reused for real archives. Its SHA-256 digest is
`d34bacb56ac1a5fcc12f8aec43c021749c1ec96b78f923bedfc5a188d89bdc9f`.

To regenerate it, build the legacy C++ CLI from the repository root with the `dev` CMake preset
(`cmake --preset dev`, then `cmake --build --preset dev --target tutorux`). Run these PowerShell
commands from the repository root:

```powershell
$fixtureWork = Join-Path $env:TEMP 'tutorux-archive-crypto-fixture'
New-Item -ItemType Directory -Path $fixtureWork -Force | Out-Null
$plainArchive = Join-Path $fixtureWork 'interop.tux'
if (Test-Path -LiteralPath $plainArchive) { Remove-Item -LiteralPath $plainArchive -Force }
npm run cli -- archive init $plainArchive --name 'Cross-language crypto fixture' --json
npm run cli -- --archive $plainArchive student create --name 'Interop Student' --json
$env:TUTORUX_INTEROP_PASSPHRASE = 'Tutorux cross-language fixture phrase 2026'
build/dev/tutorux.exe archive encrypt $plainArchive --new-passphrase-env TUTORUX_INTEROP_PASSPHRASE --json
Remove-Item Env:TUTORUX_INTEROP_PASSPHRASE
Copy-Item $plainArchive tests/fixtures/encrypted-v1.tux -Force
Get-FileHash tests/fixtures/encrypted-v1.tux -Algorithm SHA256
```

The crypto interoperability test unwraps this archive, verifies its manifest, index-page, and
commit MACs, and decrypts the student record emitted by C++.
