param(
    [Parameter(Mandatory)][string]$Message,
    [Parameter(Mandatory)][string[]]$Paths
)

# Git Bash can crash with "add_item" when the hook runs; retry only for that.
$file = Join-Path ([IO.Path]::GetTempPath()) "commit-msg-$PID.txt"
[IO.File]::WriteAllText($file, $Message, (New-Object Text.UTF8Encoding($false)))
try {
    for ($i = 1; $i -le 3; $i++) {
        $out = (git commit -F $file -- @Paths 2>&1 | Out-String)
        $code = $LASTEXITCODE
        if ($code -eq 0 -or $out -notmatch 'add_item') { break }
    }
    Write-Output $out
    exit $code
} finally {
    Remove-Item $file -ErrorAction SilentlyContinue
}
